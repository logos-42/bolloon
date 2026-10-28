// macOS 离线 OCR：Vision 框架识别图片里的中英文文字，输出纯文本到 stdout
//
// 编译（scripts/setup-ocr.sh 会做）：
//   swiftc -O scripts/vision-ocr.swift -o ~/.bolloon/bin/vision-ocr
// 用法：
//   vision-ocr /path/to/image.jpg          # OCR，逐行输出文字
//   vision-ocr --qr /path/to/image.jpg     # 二维码解码，输出码里的字符串
//
// 为什么用它：眼镜端「扫一眼匹配意图」需要把画面变成文字再交给 LLM 判断；
// 眼镜端「扫码登录」也需要把屏幕上的二维码解成登录码。
// 眼镜本身没有系统 ASR/OCR/条码服务，节点侧用 macOS Vision 离线做最省事、不要 key。
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1 else {
    FileHandle.standardError.write("usage: vision-ocr [--qr] <image>\n".data(using: .utf8)!)
    exit(1)
}

/// 二维码解码：四个方向都试一遍（眼镜拍出来可能是横的）
func decodeQR(_ cg: CGImage) -> String? {
    let orientations: [CGImagePropertyOrientation] = [.up, .right, .down, .left]
    for o in orientations {
        let req = VNDetectBarcodesRequest()
        req.symbologies = [.qr]
        let handler = VNImageRequestHandler(cgImage: cg, orientation: o, options: [:])
        do {
            try handler.perform([req])
            let codes = (req.results ?? []).compactMap { $0.payloadStringValue }
            if let first = codes.first(where: { !$0.isEmpty }) {
                return first
            }
        } catch {
            continue
        }
    }
    return nil
}

func loadCG(_ path: String) -> CGImage? {
    guard let img = NSImage(contentsOfFile: path),
          let tiff = img.tiffRepresentation,
          let bmp = NSBitmapImageRep(data: tiff) else { return nil }
    return bmp.cgImage
}

if args[1] == "--qr" {
    guard args.count > 2 else {
        FileHandle.standardError.write("usage: vision-ocr --qr <image>\n".data(using: .utf8)!)
        exit(1)
    }
    guard let cg = loadCG(args[2]) else {
        FileHandle.standardError.write("ERR: 无法解码图片\n".data(using: .utf8)!)
        exit(2)
    }
    if let code = decodeQR(cg) {
        print(code)
        exit(0)
    }
    // 没找到二维码 = 正常情况（用户没对准），不是错误
    exit(4)
}

guard let cg = loadCG(args[1]) else {
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

