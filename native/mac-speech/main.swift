// codewrench-speech: on-device dictation for the CodeWrench desktop app (macOS only).
//
// Reads the default microphone itself and prints newline-delimited JSON on stdout:
//   {"type":"ready"}                          listening has begun
//   {"type":"partial","text":"..."}           the whole transcript so far, still changing
//   {"type":"final","text":"..."}             the whole transcript, once, then the helper exits
//   {"type":"silence"}                        about 2 s without new words after some speech
//   {"type":"error","code":"...","message":"..."}
// Error codes: on_device_unavailable, permission_denied, audio_failed, recognition_failed.
// A `stop` line on stdin (or SIGTERM/SIGINT, or stdin closing) ends the recording cleanly.
// `--probe` prints {"supported":..,"onDevice":..,"locale":..,"engine":..} and exits.
// `--locale <id>` overrides the system locale.
//
// Audio never leaves this computer: recognition is refused unless the locale supports
// on-device recognition, and `requiresOnDeviceRecognition` is always set.
//
// Uses SFSpeechRecognizer (macOS 10.15+). Follow-up: macOS 26's SpeechAnalyzer/SpeechTranscriber
// is faster and needs no per-language download dance, but is not used here until it can be
// checked on a Mac.
//
// Compile with native/mac-speech/build.sh (needs the Xcode command line tools).

import AVFoundation
import Foundation
import Speech

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: []),
    var line = String(data: data, encoding: .utf8)
  else { return }
  line += "\n"
  if let bytes = line.data(using: .utf8) { FileHandle.standardOutput.write(bytes) }
}

let arguments = CommandLine.arguments
var locale = Locale.current
if let index = arguments.firstIndex(of: "--locale"), index + 1 < arguments.count {
  locale = Locale(identifier: arguments[index + 1])
}

if arguments.contains("--probe") {
  let recognizer = SFSpeechRecognizer(locale: locale)
  emit([
    "supported": recognizer != nil,
    "onDevice": recognizer?.supportsOnDeviceRecognition ?? false,
    "locale": locale.identifier,
    "engine": "sfspeech",
  ])
  exit(0)
}

final class Dictation {
  private let locale: Locale
  private let engine = AVAudioEngine()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var timer: DispatchSourceTimer?
  private var text = ""
  private var lastChange = Date()
  private var silenceSent = false
  private var stopping = false
  private var finished = false

  init(locale: Locale) { self.locale = locale }

  private func fail(_ code: String, _ message: String) {
    if finished { return }
    finished = true
    emit(["type": "error", "code": code, "message": message])
    cleanup()
    exit(1)
  }

  private func cleanup() {
    timer?.cancel()
    if engine.isRunning {
      engine.stop()
      engine.inputNode.removeTap(onBus: 0)
    }
    task?.cancel()
  }

  private func complete() {
    if finished { return }
    finished = true
    emit(["type": "final", "text": text])
    cleanup()
    exit(0)
  }

  func begin() {
    guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.supportsOnDeviceRecognition
    else {
      fail(
        "on_device_unavailable",
        "On-device speech recognition is not available for \(locale.identifier).")
      return
    }
    SFSpeechRecognizer.requestAuthorization { status in
      DispatchQueue.main.async {
        guard status == .authorized else {
          self.fail(
            "permission_denied",
            "Speech Recognition is turned off for CodeWrench. Allow it in System Settings > Privacy & Security > Speech Recognition."
          )
          return
        }
        self.requestMicrophone(recognizer)
      }
    }
  }

  private func requestMicrophone(_ recognizer: SFSpeechRecognizer) {
    let denied =
      "Microphone access is turned off for CodeWrench. Allow it in System Settings > Privacy & Security > Microphone."
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
      listen(recognizer)
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .audio) { granted in
        DispatchQueue.main.async {
          if granted { self.listen(recognizer) } else { self.fail("permission_denied", denied) }
        }
      }
    default:
      fail("permission_denied", denied)
    }
  }

  private func listen(_ recognizer: SFSpeechRecognizer) {
    guard recognizer.isAvailable else {
      fail("on_device_unavailable", "Speech recognition is not available right now.")
      return
    }
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.requiresOnDeviceRecognition = true
    if #available(macOS 13.0, *) { request.addsPunctuation = true }
    self.request = request

    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      fail("audio_failed", "No microphone input is available.")
      return
    }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
      request.append(buffer)
    }
    engine.prepare()
    do { try engine.start() } catch {
      fail("audio_failed", "The microphone could not be opened: \(error.localizedDescription)")
      return
    }

    task = recognizer.recognitionTask(with: request) { result, error in
      DispatchQueue.main.async { self.receive(result, error) }
    }
    startSilenceTimer()
    emit(["type": "ready"])
  }

  private func receive(_ result: SFSpeechRecognitionResult?, _ error: Error?) {
    if finished { return }
    if let result = result {
      let next = result.bestTranscription.formattedString
      if next != text {
        text = next
        lastChange = Date()
        silenceSent = false
        if !result.isFinal { emit(["type": "partial", "text": text]) }
      }
      if result.isFinal {
        complete()
        return
      }
    }
    if error != nil {
      // After a stop, a recognizer that errors while wrapping up still has the words it heard.
      if stopping || !text.isEmpty { complete() } else {
        fail("recognition_failed", "Speech recognition stopped unexpectedly.")
      }
    }
  }

  private func startSilenceTimer() {
    let source = DispatchSource.makeTimerSource(queue: .main)
    source.schedule(deadline: .now() + 0.25, repeating: 0.25)
    source.setEventHandler { [weak self] in
      guard let self = self, !self.stopping, !self.silenceSent, !self.text.isEmpty else { return }
      if Date().timeIntervalSince(self.lastChange) >= 2.0 {
        self.silenceSent = true
        emit(["type": "silence"])
      }
    }
    source.resume()
    timer = source
  }

  func stop() {
    if stopping || finished { return }
    stopping = true
    guard request != nil else {
      // Stopped before listening began: nothing was heard.
      complete()
      return
    }
    if engine.isRunning {
      engine.stop()
      engine.inputNode.removeTap(onBus: 0)
    }
    request?.endAudio()
    // The recognizer normally delivers its final result right after endAudio; do not wait forever.
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.complete() }
  }
}

let dictation = Dictation(locale: locale)
// Dispatch sources stop firing once released, so keep them for the life of the process.
var signalSources: [DispatchSourceSignal] = []

for signalNumber in [SIGTERM, SIGINT] {
  signal(signalNumber, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
  source.setEventHandler { dictation.stop() }
  source.resume()
  signalSources.append(source)
}

DispatchQueue.global().async {
  while let line = readLine() {
    if line.trimmingCharacters(in: .whitespacesAndNewlines) == "stop" {
      DispatchQueue.main.async { dictation.stop() }
      return
    }
  }
  // The app closed our stdin or died: finish rather than keep the microphone open.
  DispatchQueue.main.async { dictation.stop() }
}

DispatchQueue.main.async { dictation.begin() }
dispatchMain()
