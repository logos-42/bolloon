// macOS 离线 OCR：Vision 框架识别图片里的中英文文字，输出纯文本到 stdout
//
// 编译（scripts/setup-ocr.sh 会做）：
//   swiftc -O scripts/vision-ocr.swift -o ~/.bolloon/bin/vision-ocr
// 用法：
//   vision-ocr /path/to/image.jpg
//
// 为什么用它：眼镜端「扫一眼匹配意图」需要把画面变成文字再交给 LLM 判断。
// 眼镜本身没有系统 ASR/OCR 服务，节点侧用 macOS Vision 离线识别最省事、不要 key。
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1 else {
    FileHandle.standardError.write("usage: vision-ocr <image>\n".data(using: .utf8)!)
    exit(1)
}
let url = URL(fileURLWithPath: args[1])
guard let img = NSImage(contentsOf: url),
      let tiff = img.tiffRepresentation,
      let bmp = NSBitmapImageRep(data: tiff),
      let cg = bmp.cgImage else {
    FileHandle.standardError.write("ERR: 无法解码图片\n".data(using: .utf8)!)
    exit(2)
}

let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.recognitionLanguages = ["zh-Hans", "en-US"]
req.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
    try handler.perform([req])
    let lines = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    print(lines.joined(separator: "\n"))
} catch {
    FileHandle.standardError.write("ERR: \(error)\n".data(using: .utf8)!)
    exit(3)
}
