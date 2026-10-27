Pod::Spec.new do |s|
  s.name = 'ProductionFaults'
  s.version = '1.0.0'
  s.summary = 'Test-only bounded native fault helper'
  s.description = s.summary
  s.license = 'MIT'
  s.author = 'RNAA Lab'
  s.homepage = 'https://expo.dev'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { git: 'https://expo.dev' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
end
