package expo.modules.productionfaults

import android.app.Activity
import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Debug
import android.os.PowerManager
import android.os.SystemClock
import android.util.AtomicFile
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.sin

class ProductionFaultsModule : Module() {
  private lateinit var context: Context
  private val lock = Any()
  private var runId = ""
  private var sequence = 0
  private var appState = "active"
  private var lastVolume = -1
  private var guardReason: String? = null
  private val events = mutableListOf<Map<String, Any?>>()
  private val scheduler = Executors.newSingleThreadScheduledExecutor()
  @Volatile private var pressure: Pressure? = null
  private class Pressure(val workers: Int, val duty: Double, var memory: ByteArray?) {
    val active = AtomicBoolean(true)
    val busy = AtomicLong(0)
    val threads = mutableListOf<Thread>()
    @Volatile var deadline = SystemClock.elapsedRealtime() + 180000
  }
  private val lifecycle = object : Application.ActivityLifecycleCallbacks {
    override fun onActivityResumed(activity: Activity) { appState = "active"; record("appState", appState) }
    override fun onActivityPaused(activity: Activity) { appState = "inactive"; record("appState", appState) }
    override fun onActivityStopped(activity: Activity) { appState = "background"; record("appState", appState) }
    override fun onActivityCreated(a: Activity, b: Bundle?) {}
    override fun onActivityStarted(a: Activity) {}
    override fun onActivitySaveInstanceState(a: Activity, b: Bundle) {}
    override fun onActivityDestroyed(a: Activity) {}
  }
  private val routes = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(devices: Array<out AudioDeviceInfo>) { record("routeChange", "added") }
    override fun onAudioDevicesRemoved(devices: Array<out AudioDeviceInfo>) { record("routeChange", "removed") }
  }
  private val recordings = object : AudioManager.AudioRecordingCallback() {
    override fun onRecordingConfigChanged(configs: MutableList<android.media.AudioRecordingConfiguration>) {
      if (Build.VERSION.SDK_INT >= 29) record("captureConfiguration", configs.map { mapOf("silenced" to it.isClientSilenced, "sessionId" to it.clientAudioSessionId) })
    }
  }
  private fun thermal(): Int = if (Build.VERSION.SDK_INT >= 29) (context.getSystemService(Context.POWER_SERVICE) as PowerManager).currentThermalStatus else -1
  private fun enabled(): Boolean = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA).metaData?.getBoolean("RNAAProductionFaultsEnabled", false) == true
  override fun definition() = ModuleDefinition {
    Name("ProductionFaults")
    OnCreate {
      context = appContext.reactContext!!.applicationContext
      (context as Application).registerActivityLifecycleCallbacks(lifecycle)
      (context.getSystemService(Context.AUDIO_SERVICE) as AudioManager).registerAudioDeviceCallback(routes, null)
      (context.getSystemService(Context.AUDIO_SERVICE) as AudioManager).registerAudioRecordingCallback(recordings, null)
      scheduler.scheduleAtFixedRate({
        try {
          val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
          val volume = audio.getStreamVolume(AudioManager.STREAM_MUSIC)
          if (volume != lastVolume) { if (lastVolume >= 0) record("systemVolume", volume); lastVolume = volume }
          val p = pressure
          val thermal = thermal()
          if (p != null && (SystemClock.elapsedRealtime() >= p.deadline || thermal >= PowerManager.THERMAL_STATUS_CRITICAL)) {
            guardReason = if (thermal >= PowerManager.THERMAL_STATUS_CRITICAL) "critical-thermal" else "native-expiry"
            record("pressureGuard", guardReason); stopPressure()
          }
          persist()
        } catch (error: Exception) { record("helperError", error.toString()) }
      }, 1, 1, TimeUnit.SECONDS)
    }
    OnDestroy {
      stopPressure(); scheduler.shutdownNow()
      (context as Application).unregisterActivityLifecycleCallbacks(lifecycle)
      (context.getSystemService(Context.AUDIO_SERVICE) as AudioManager).unregisterAudioDeviceCallback(routes)
      (context.getSystemService(Context.AUDIO_SERVICE) as AudioManager).unregisterAudioRecordingCallback(recordings)
    }
    Function("capabilities") { mapOf("available" to enabled(), "pressure" to (enabled() && Build.VERSION.SDK_INT >= 29), "cores" to Runtime.getRuntime().availableProcessors(), "realServiceReset" to hostResetAvailable(), "platform" to "android", "reason" to "Real service reset needs host root preflight and native audioserver PID evidence.") }
    Function("beginRun") { id: String ->
      require(enabled()); require(id.matches(Regex("[A-Za-z0-9_-]{1,100}")))
      synchronized(lock) { runId = id; sequence = 0; events.clear(); guardReason = null }
      record("runStarted", id); persist()
    }
    AsyncFunction("startPressure") { workers: Int, duty: Double, memoryMiB: Int ->
      require(enabled()); require(workers in 1..Runtime.getRuntime().availableProcessors() && duty in 0.0..0.85 && memoryMiB in 0..128)
      stopPressure()
      check(thermal() < PowerManager.THERMAL_STATUS_CRITICAL) { "Device is already at critical thermal state" }
      val info = ActivityManager.MemoryInfo(); (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(info)
      val bytes = minOf(memoryMiB.toLong() * 1048576, info.availMem / 10).toInt()
      val memory = try { ByteArray(bytes) } catch (_: OutOfMemoryError) { throw IllegalStateException("Pressure memory allocation was rejected; no workers started") }
      for (i in memory.indices step 4096) memory[i] = 1
      val p = Pressure(workers, duty, memory); pressure = p; guardReason = null
      repeat(workers) {
        val thread = Thread({
          var checksum = .123
          while (p.active.get()) {
            val start = SystemClock.elapsedRealtimeNanos(); val end = start + (20000000 * duty).toLong()
            while (p.active.get() && SystemClock.elapsedRealtimeNanos() < end) checksum = sin(checksum + .001)
            p.busy.addAndGet((SystemClock.elapsedRealtimeNanos() - start) / 1000000)
            try { Thread.sleep((20 * (1 - duty)).toLong().coerceAtLeast(1)) } catch (_: InterruptedException) {}
          }
          if (checksum.isNaN()) record("workerError", "non-finite checksum")
        }, "production-load-$it")
        p.threads.add(thread); thread.start()
      }
      record("pressureStarted", mapOf("workers" to workers, "duty" to duty, "allocatedBytes" to bytes)); persist()
    }
    Function("renewPressure") { pressure?.deadline = SystemClock.elapsedRealtime() + 180000 }
    AsyncFunction("stopPressure") { stopPressure(); persist() }
    Function("snapshot") { snapshot() }
    AsyncFunction("endRun") { stopPressure(); record("runEnded", runId); persist(); synchronized(lock) { runId = "" } }
  }
  private fun stopPressure() {
    val p = pressure ?: return
    p.active.set(false); p.threads.forEach { it.interrupt() }; p.threads.forEach { if (it !== Thread.currentThread()) it.join(1500) }
    record("pressureStopped", mapOf("workerBusyMs" to p.busy.get(), "allocatedBytes" to (p.memory?.size ?: 0)))
    p.memory = null; if (pressure === p) pressure = null
  }
  private fun record(name: String, value: Any?) = synchronized(lock) {
    if (runId.isNotEmpty()) {
      if (events.size >= 256) events.removeAt(0)
      events.add(mapOf("sequence" to ++sequence, "at" to System.currentTimeMillis(), "name" to name, "value" to value, "source" to "native"))
    }
  }
  private fun snapshot(): Map<String, Any?> = synchronized(lock) {
    val info = ActivityManager.MemoryInfo(); (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(info)
    val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    mapOf("runId" to runId, "at" to System.currentTimeMillis(), "appState" to appState,
      "pressureActive" to (pressure?.active?.get() == true), "guardReason" to guardReason,
      "memoryKind" to "pss", "residentBytes" to Debug.getPss().toLong() * 1024, "availableBytes" to info.availMem,
      "thermal" to thermal(),
      "allocatedBytes" to (pressure?.memory?.size ?: 0), "workers" to (pressure?.workers ?: 0), "duty" to (pressure?.duty ?: 0.0),
      "workerBusyMs" to (pressure?.busy?.get() ?: 0), "cpuTimeMs" to android.os.Process.getElapsedCpuTime(),
      "systemVolume" to audio.getStreamVolume(AudioManager.STREAM_MUSIC),
      "route" to mapOf("actualMediaRouteVerified" to false, "communicationDevice" to (if (Build.VERSION.SDK_INT >= 31) audio.communicationDevice?.type else null),
        "availableDevices" to audio.getDevices(AudioManager.GET_DEVICES_ALL).map { mapOf("id" to it.id, "type" to it.type, "input" to it.isSource) }),
      "hostServiceReset" to hostResetEvidence(), "events" to events.toList())
  }
  private fun hostResetAvailable(): Boolean = try {
    val value = JSONObject(File(context.filesDir, "production-host-capabilities.json").readText())
    enabled() && value.optBoolean("realServiceReset") && value.optLong("expiresAt") > System.currentTimeMillis()
  } catch (_: Exception) { false }
  private fun hostResetEvidence(): Map<String, Any?> = try {
    val value = JSONObject(File(context.filesDir, "production-host-$runId.json").readText())
    mapOf("verified" to (value.optBoolean("verified") && value.optString("runId") == runId), "beforePid" to value.optString("beforePid"), "afterPid" to value.optString("afterPid"), "at" to value.optLong("at"), "source" to "host-audioserver-pid")
  } catch (_: Exception) { mapOf("verified" to false) }
  private fun persist() = synchronized(lock) {
    if (runId.isNotEmpty()) {
      val target = AtomicFile(File(context.filesDir, "production-native-$runId.json"))
      val stream = target.startWrite()
      try { stream.write(JSONObject(snapshot()).toString().toByteArray()); target.finishWrite(stream) } catch (e: Exception) { target.failWrite(stream); throw e }
      context.filesDir.listFiles { file -> file.name.startsWith("production-native-") && file.name.endsWith(".json") }?.sortedByDescending { it.lastModified() }?.drop(40)?.forEach { it.delete() }
    }
  }
}
