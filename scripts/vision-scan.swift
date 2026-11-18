// 图片内容体检工具（macOS Vision 框架）—— 上架前用来查图里的违禁内容。
//
// 为什么需要它（2026-10-08 真实事故）：
//   一个 Blender 插件的**封面图里有「GPT」字样** → 闲鱼判定违规 → **账号被封控**。
//   纯文本扫描挡不住这种情况 —— 违禁词在**图里**，只能靠 OCR 读出来。
//
// 用法：
//   vision-scan <图片1> <图片2> ...
// 输出：一行一个 JSON 对象（便于流式处理大图集）
//   {"file":"/path/a.png","texts":["GPT-4o",...],"labels":[{"id":"bikini","c":0.83}],
//    "skinRatio":0.12,"skinCenter":0.31,"width":1080,"height":1080,"error":null}
//
// 三项能力：
//   1. VNRecognizeTextRequest   —— OCR，把图里的文字读出来（查违禁词）
//   2. VNClassifyImageRequest   —— 图像分类（~1300 类），能识别 bikini/lingerie 这类概念
//   3. 肤色像素占比             —— 兜底启发式，补分类器漏掉的暴露画面
//
// 编译：swiftc -O -o <bin> vision-scan.swift -framework Vision -framework AppKit -framework CoreGraphics

import Foundation
import Vision
import AppKit
import CoreGraphics

struct Label: Codable { let id: String; let c: Float }
struct Result: Codable {
    var file: String
    var texts: [String] = []
    var labels: [Label] = []
    var skinRatio: Double = 0
    var skinCenter: Double = 0
    var width: Int = 0
    var height: Int = 0
    var error: String? = nil
}

/// 肤色像素判定（RGB + YCbCr 双条件，抑制误判）
/// 参考常用肤色检测规则：R>95, G>40, B>20, max-min>15, |R-G|>15, R>G, R>B
/// 再加 YCbCr 域：77<=Cb<=127, 133<=Cr<=173
func isSkin(_ r: Int, _ g: Int, _ b: Int) -> Bool {
    let mx = max(r, max(g, b)), mn = min(r, min(g, b))
    let rgbOK = r > 95 && g > 40 && b > 20 && (mx - mn) > 15
        && abs(r - g) > 15 && r > g && r > b
    let cb = 128 - 0.168736 * Double(r) - 0.331264 * Double(g) + 0.5 * Double(b)
    let cr = 128 + 0.5 * Double(r) - 0.418688 * Double(g) - 0.081312 * Double(b)
    let yccOK = cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173
    return rgbOK && yccOK
}

func scan(_ path: String) -> Result {
    var res = Result(file: path)
    guard let img = NSImage(contentsOfFile: path),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil)
    else {
        res.error = "无法读取图片"
        return res
    }
    res.width = cg.width
    res.height = cg.height

    let handler = VNImageRequestHandler(cgImage: cg, options: [:])

    // ---- 1. OCR ----
    let ocr = VNRecognizeTextRequest()
    ocr.recognitionLevel = .accurate
    ocr.usesLanguageCorrection = false           // 关掉纠错：违禁词多为英文缩写，纠错会改写结果
    ocr.recognitionLanguages = ["en-US", "zh-Hans"]
    // ---- 2. 图像分类 ----
    let cls = VNClassifyImageRequest()

    do {
        try handler.perform([ocr, cls])
    } catch {
        res.error = "Vision 执行失败: \(error.localizedDescription)"
        return res
    }

    if let obs = ocr.results {
        for o in obs {
            if let top = o.topCandidates(1).first { res.texts.append(top.string) }
        }
    }
    if let obs = cls.results {
        // 只保留置信度 >= 0.10 的，避免噪音
        res.labels = obs.filter { $0.confidence >= 0.10 }
            .map { Label(id: $0.identifier, c: $0.confidence) }
            .sorted { $0.c > $1.c }
    }

    // ---- 3. 肤色占比 ----
    let w = cg.width, h = cg.height
    if w > 0 && h > 0 {
        let sampleW = min(w, 320)               // 缩采样即可，够判断比例
        let sampleH = max(1, Int(Double(h) * Double(sampleW) / Double(w)))
        var buf = [UInt8](repeating: 0, count: sampleW * sampleH * 4)
        if let ctx = CGContext(data: &buf, width: sampleW, height: sampleH,
                               bitsPerComponent: 8, bytesPerRow: sampleW * 4,
                               space: CGColorSpaceCreateDeviceRGB(),
                               bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: sampleW, height: sampleH))
            var total = 0, skin = 0, centerTotal = 0, centerSkin = 0
            let cx0 = sampleW / 4, cx1 = sampleW * 3 / 4
            let cy0 = sampleH / 4, cy1 = sampleH * 3 / 4
            var y = 0
            while y < sampleH {
                var x = 0
                while x < sampleW {
                    let i = (y * sampleW + x) * 4
                    let r = Int(buf[i]), g = Int(buf[i + 1]), b = Int(buf[i + 2])
                    let s = isSkin(r, g, b)
                    total += 1; if s { skin += 1 }
                    if x >= cx0 && x < cx1 && y >= cy0 && y < cy1 {
                        centerTotal += 1; if s { centerSkin += 1 }
                    }
                    x += 1
                }
                y += 1
            }
            if total > 0 { res.skinRatio = Double(skin) / Double(total) }
            if centerTotal > 0 { res.skinCenter = Double(centerSkin) / Double(centerTotal) }
        }
    }
    return res
}

let files = Array(CommandLine.arguments.dropFirst())
if files.isEmpty {
    FileHandle.standardError.write("用法: vision-scan <图片...>\n".data(using: .utf8)!)
    exit(2)
}
let encoder = JSONEncoder()
encoder.outputFormatting = []
for f in files {
    let r = scan(f)
    if let d = try? encoder.encode(r), let s = String(data: d, encoding: .utf8) {
        print(s)
    }
}
