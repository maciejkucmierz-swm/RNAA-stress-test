import ExpoModulesCore
import UIKit
import AVFAudio
import Darwin

private final class Pressure {
  let workers: Int
  let duty: Double
  var memory: UnsafeMutableRawPointer?
  let allocatedBytes: Int
  let group = DispatchGroup()
  let lock = NSLock()
  var active = true
  var deadline = ProcessInfo.processInfo.systemUptime + 180
  var busyMs: Double = 0
  init(workers: Int, duty: Double, bytes: Int) {
    self.workers = workers; self.duty = duty; self.allocatedBytes = bytes
    memory = calloc(max(1, bytes), 1)
    if let pointer = memory { for index in stride(from: 0, to: bytes, by: 4096) { pointer.storeBytes(of: UInt8(1), toByteOffset: index, as: UInt8.self) } }
  }
  func running() -> Bool { lock.lock(); defer { lock.unlock() }; return active }
}
public class ProductionFaultsModule: Module {
  private let lock = NSRecursiveLock()
  private let journalQueue = DispatchQueue(label: "production-native-journal")
  private var timer: DispatchSourceTimer?
  private var observers: [NSObjectProtocol] = []
  private var volumeObserver: NSKeyValueObservation?
  private var runId = ""
  private var sequence = 0
  private var appState = "active"
  private var guardReason: String?
  private var events: [[String: Any]] = []
  private var pressure: Pressure?
  private var enabled: Bool { Bundle.main.object(forInfoDictionaryKey: "RNAAProductionFaultsEnabled") as? Bool == true }
  public func definition() -> ModuleDefinition {
    Name("ProductionFaults")
    OnCreate { self.installObservers() }
    OnDestroy {
      self.stopPressure()
      self.timer?.cancel()
      self.observers.forEach { NotificationCenter.default.removeObserver($0) }
      self.volumeObserver?.invalidate()
    }
    Function("capabilities") { () -> [String: Any] in
      #if targetEnvironment(simulator)
      let reset = false
      #else
      let reset = self.enabled
      #endif
      return ["available": self.enabled, "pressure": self.enabled, "cores": ProcessInfo.processInfo.activeProcessorCount,
        "realServiceReset": reset, "platform": "ios", "reason": "Real reset requires physical iPhone Developer Settings and a native reset event."]
    }
    Function("beginRun") { (id: String) in
      guard self.enabled, id.range(of: "^[A-Za-z0-9_-]{1,100}$", options: .regularExpression) != nil else { throw self.failure("Native helper disabled or invalid run ID") }
      self.lock.lock(); self.runId = id; self.sequence = 0; self.events = []; self.guardReason = nil; self.lock.unlock()
      self.record("runStarted", id); self.persist()
    }
    AsyncFunction("startPressure") { (workers: Int, duty: Double, memoryMiB: Int) in
      guard self.enabled, workers > 0, workers <= ProcessInfo.processInfo.activeProcessorCount, duty >= 0, duty <= 0.85, memoryMiB >= 0, memoryMiB <= 128 else { throw self.failure("Invalid pressure settings") }
      self.stopPressure()
      guard ProcessInfo.processInfo.thermalState != .critical else { throw self.failure("Device is already at critical thermal state") }
      let bytes = min(memoryMiB * 1048576, Int(os_proc_available_memory() / 10))
      let p = Pressure(workers: workers, duty: duty, bytes: bytes)
      guard p.memory != nil else { throw self.failure("Pressure memory allocation failed") }
      self.lock.lock(); self.pressure = p; self.guardReason = nil; self.lock.unlock()
      for index in 0..<workers {
        p.group.enter()
        let thread = Thread {
          var checksum = 0.123
          while p.running() {
            let start = ProcessInfo.processInfo.systemUptime
            while p.running() && ProcessInfo.processInfo.systemUptime - start < 0.02 * duty {
              for _ in 0..<100 { checksum = sin(checksum + 0.001) }
            }
            p.lock.lock(); p.busyMs += (ProcessInfo.processInfo.systemUptime - start) * 1000; p.lock.unlock()
            Thread.sleep(forTimeInterval: max(0.001, 0.02 * (1 - duty)))
          }
          if !checksum.isFinite { self.record("workerError", "non-finite checksum") }
          p.group.leave()
        }
        thread.name = "production-load-\(index)"; thread.start()
      }
      self.record("pressureStarted", ["workers": workers, "duty": duty, "allocatedBytes": bytes]); self.persist()
    }
    Function("renewPressure") {
      self.lock.lock(); let p = self.pressure; self.lock.unlock()
      p?.lock.lock(); p?.deadline = ProcessInfo.processInfo.systemUptime + 180; p?.lock.unlock()
    }
    AsyncFunction("stopPressure") { self.stopPressure(); self.persist() }
    Function("snapshot") { self.snapshot() }
    AsyncFunction("endRun") { self.stopPressure(); self.record("runEnded", self.runId); self.persist(); self.lock.lock(); self.runId = ""; self.lock.unlock() }
  }
  private func failure(_ message: String) -> NSError { NSError(domain: "ProductionFaults", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
  private func installObservers() {
    let center = NotificationCenter.default
    for (notification, state) in [(UIApplication.didBecomeActiveNotification, "active"), (UIApplication.willResignActiveNotification, "inactive"), (UIApplication.didEnterBackgroundNotification, "background")] {
      observers.append(center.addObserver(forName: notification, object: nil, queue: nil) { [weak self] _ in self?.lock.lock(); self?.appState = state; self?.record("appState", state); self?.lock.unlock() })
    }
    for (notification, name) in [(AVAudioSession.mediaServicesWereLostNotification, "mediaServicesLost"), (AVAudioSession.mediaServicesWereResetNotification, "mediaServicesReset")] {
      observers.append(center.addObserver(forName: notification, object: nil, queue: nil) { [weak self] _ in self?.record(name, "observed") })
    }
    observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) { [weak self] note in
      self?.record("routeChange", ["reason": note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0])
    })
    observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] note in
      let began = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.began.rawValue
      let options = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
      self?.record("interruption", ["type": began ? "began" : "ended", "shouldResume": options & AVAudioSession.InterruptionOptions.shouldResume.rawValue != 0])
    })
    volumeObserver = AVAudioSession.sharedInstance().observe(\.outputVolume, options: [.new]) { [weak self] _, change in self?.record("systemVolume", change.newValue ?? 0) }
    let timer = DispatchSource.makeTimerSource(queue: journalQueue)
    timer.schedule(deadline: .now() + 1, repeating: 1)
    timer.setEventHandler { [weak self] in
      guard let self else { return }
      self.lock.lock(); let p = self.pressure; self.lock.unlock()
      if let p {
        p.lock.lock(); let expired = ProcessInfo.processInfo.systemUptime >= p.deadline; p.lock.unlock()
        if expired || ProcessInfo.processInfo.thermalState == .critical {
          self.lock.lock(); self.guardReason = expired ? "native-expiry" : "critical-thermal"; self.lock.unlock()
          self.record("pressureGuard", self.guardReason ?? "unknown"); self.stopPressure()
        }
      }
      self.persist()
    }
    self.timer = timer; timer.resume()
  }
  private func stopPressure() {
    lock.lock(); let p = pressure; lock.unlock()
    guard let p else { return }
    p.lock.lock(); p.active = false; p.lock.unlock(); p.group.wait()
    lock.lock(); defer { lock.unlock() }
    if pressure === p {
      record("pressureStopped", ["workerBusyMs": p.busyMs, "allocatedBytes": p.allocatedBytes])
      free(p.memory); p.memory = nil; pressure = nil
    }
  }
  private func record(_ name: String, _ value: Any) {
    lock.lock(); defer { lock.unlock() }
    guard !runId.isEmpty else { return }
    sequence += 1
    if events.count >= 256 { events.removeFirst() }
    events.append(["sequence": sequence, "at": Date().timeIntervalSince1970 * 1000, "name": name, "value": value, "source": "native"])
  }
  private func snapshot() -> [String: Any] {
    lock.lock(); defer { lock.unlock() }
    var info = mach_task_basic_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info_data_t>.size / MemoryLayout<integer_t>.size)
    let result = withUnsafeMutablePointer(to: &info) { pointer in pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count) } }
    var usage = rusage(); getrusage(RUSAGE_SELF, &usage)
    let cpuMs = Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) * 1000 + Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1000
    pressure?.lock.lock(); let busy = pressure?.busyMs ?? 0; pressure?.lock.unlock()
    return ["runId": runId, "at": Date().timeIntervalSince1970 * 1000, "appState": appState, "pressureActive": pressure != nil,
      "guardReason": guardReason as Any? ?? NSNull(), "memoryKind": "resident", "residentBytes": result == KERN_SUCCESS ? info.resident_size : 0,
      "availableBytes": os_proc_available_memory(), "thermal": ProcessInfo.processInfo.thermalState.rawValue,
      "allocatedBytes": pressure?.allocatedBytes ?? 0, "workers": pressure?.workers ?? 0, "duty": pressure?.duty ?? 0,
      "workerBusyMs": busy, "cpuTimeMs": cpuMs, "systemVolume": AVAudioSession.sharedInstance().outputVolume,
      "route": ["actual": true, "inputs": AVAudioSession.sharedInstance().currentRoute.inputs.map { ["type": $0.portType.rawValue, "name": $0.portName] },
        "outputs": AVAudioSession.sharedInstance().currentRoute.outputs.map { ["type": $0.portType.rawValue, "name": $0.portName] }], "events": events]
  }
  private func persist() {
    lock.lock(); defer { lock.unlock() }
    guard !runId.isEmpty else { return }
    do {
      let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      let data = try JSONSerialization.data(withJSONObject: snapshot())
      try data.write(to: directory.appendingPathComponent("production-native-\(runId).json"), options: .atomic)
      let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey]).filter { $0.lastPathComponent.hasPrefix("production-native-") && $0.pathExtension == "json" }.sorted {
        let lhs = (try? $0.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
        let rhs = (try? $1.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
        return lhs > rhs
      }
      for file in files.dropFirst(40) { try? FileManager.default.removeItem(at: file) }
    } catch { NSLog("ProductionFaults journal write failed: %@", String(describing: error)) }
  }
}
