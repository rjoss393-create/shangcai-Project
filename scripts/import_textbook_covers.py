# -*- coding: utf-8 -*-
"""从教材电子版抽真封面 → data/media/books/tb-<slug>.jpg

抽取规则（2026-09-23 收紧，原因是「空白/版权页/横向跨页」被误当封面）：
  PDF
    ① 前 8 页里第 1 个「竖版 且 非白占比 ≥ 15%」的页 → 封面
    ② 都没有（说明这本没有封面美术，例如排版好的电子书）→ 退回第 1–3 页里
       最后一个有内容（非白 ≥ 1%）的页，通常就是书名页
    ③ 再没有 → 前 10 页里内容最多的页，且非白 ≥ 10%
    ④ 选中的页若是横向（宽 > 高，说明是跨页扫描）→ 判定「无可用封面」
    ⑤ 最终非白 < 8% → 判定「无可用封面」
  EPUB
    ① OPF 里的 cover-image，且必须是竖版
    ② 兜底：全 zip 里「竖版 且 面积 ≥ 最大图 30%」的最大一张（滤掉几百张行内小插图）
    ③ 再兜底：最大的一张图（横向则视为无封面）
  → 返回 None 的书，前端用 cover:'' 走「编号 + 书名」占位（比放一张空白图好看）

不覆盖原有 01-35.png，另存 tb-*.jpg；同时输出对照图 covers_contact_sheet.png 供肉眼验收。
"""
import io, json, os, re, sys, zipfile
sys.stdout.reconfigure(encoding='utf-8')
import pymupdf
from PIL import Image, ImageDraw

ROOT = r'E:/上财项目(控制层)'
MANIFEST = os.path.join(ROOT, 'data/media/textbooks.json')
SRC = os.path.join(ROOT, 'data/media/textbooks')
OUT = os.path.join(ROOT, 'data/media/books')
SHEET = r'E:/galaxy_probe/covers_contact_sheet.png'
TARGET_W = 480
PDF_SCAN_PAGES = 8
R_FIRST, R_COVER = 0.04, 0.15

report = {}


def to_img(pix):
    return Image.frombytes('RGB', (pix.width, pix.height), pix.samples)


def ratio(img):
    g = img.convert('L')
    d = list(g.getdata())[::7]
    return sum(1 for v in d if v < 240) / max(1, len(d))


def render(page, width=TARGET_W):
    z = width / max(1.0, page.rect.width)
    return to_img(page.get_pixmap(matrix=pymupdf.Matrix(z, z)))


def save(img, slug):
    img = img.convert('RGB')
    w, h = img.size
    if w > TARGET_W:
        img = img.resize((TARGET_W, max(1, round(h * TARGET_W / w))), Image.LANCZOS)
    p = os.path.join(OUT, 'tb-%s.jpg' % slug)
    img.save(p, 'JPEG', quality=85, optimize=True)
    return p


def pdf_cover(path):
    """判定顺序（2026-09-23 按 22 本 PDF 的逐页实测定的）：
       A. 第 1 页竖版且非白 ≥ 4%  → 直接用（扫描件的封面页几乎都在第 1 页）
       B. 否则在前 8 页里找第 1 个「竖版 + 非白 ≥ 15% + 有内嵌图」的页
          （挡掉两类误判：排版电子书的书名页只有 0.5–1.8% 非白且无内嵌图；
            横向跨页扫描既非竖版也不该整页拿来当封面）
       C. 都不满足 → 判定没有可用封面，交给前端走「编号 + 书名」占位
    """
    doc = pymupdf.open(path)
    n = min(doc.page_count, 10)
    info = []
    for i in range(n):
        pg = doc[i]
        img = render(pg)
        info.append((i, img, ratio(img), pg.rect.width > pg.rect.height,
                     len(pg.get_images(full=True))))
    doc.close()

    i0, img0, r0, land0, n0 = info[0]
    hide = '第1页封面 · 非白%.0f%%' % (r0 * 100)
    if not land0 and r0 >= R_FIRST:
        return img0, hide, r0
    for i, img, r, land, nimg in info[1:PDF_SCAN_PAGES]:
        if (not land) and r >= R_COVER and nimg >= 1:
            return img, '第%d页扫描封面 · 非白%.0f%%' % (i + 1, r * 100), r
    return None, '无封面美术/跨页扫描（第1页非白%.1f%%、内嵌图%d）' % (r0 * 100, n0), r0


def epub_cover(path):
    z = zipfile.ZipFile(path)
    names = z.namelist()
    opf = None
    try:
        cont = z.read('META-INF/container.xml').decode('utf-8', 'ignore')
        m = re.search(r'full-path="([^"]+)"', cont)
        opf = m.group(1) if m else None
    except Exception:
        pass
    if not opf:
        opf = next((n for n in names if n.lower().endswith('.opf')), None)

    def load(n):
        try:
            return Image.open(io.BytesIO(z.read(n)))
        except Exception:
            return None

    cand, rule = None, None
    if opf:
        try:
            x = z.read(opf).decode('utf-8', 'ignore')
            base = os.path.dirname(opf)
            items = re.findall(r'<item\b[^>]*>', x)
            href = None
            for it in items:
                if 'cover-image' in it:
                    m = re.search(r'href="([^"]+)"', it)
                    href = m.group(1) if m else None
                    break
            if not href:
                m = re.search(r'<meta[^>]*name="cover"[^>]*content="([^"]+)"', x, re.I)
                if m:
                    for it in items:
                        if re.search(r'id="%s"' % re.escape(m.group(1)), it):
                            h = re.search(r'href="([^"]+)"', it)
                            href = h.group(1) if h else None
                            break
            if not href:
                m = re.search(r'<reference[^>]*type="cover"[^>]*href="([^"]+)"', x, re.I)
                href = m.group(1) if m else None
            if href:
                p = os.path.join(base, href).replace('\\', '/').lstrip('./')
                if p in names and p.lower().endswith(('.jpg', '.jpeg', '.png', '.gif', '.webp')):
                    im = load(p)
                    if im and im.size[1] >= im.size[0]:
                        return im, 'OPF cover-image · %dx%d' % im.size, 1.0
                    cand = im  # 横向，先记下，往下找竖版
        except Exception:
            pass

    imgs = []
    for n in names:
        if n.lower().endswith(('.jpg', '.jpeg', '.png', '.gif', '.webp')):
            im = load(n)
            if im:
                imgs.append((n, im, im.size[0] * im.size[1]))
    if not imgs:
        return None, 'EPUB 内无图片', 0.0
    maxarea = max(a for _, _, a in imgs)
    portrait = [(n, im, a) for n, im, a in imgs if im.size[1] >= im.size[0] and a >= 0.3 * maxarea]
    if portrait:
        n, im, a = max(portrait, key=lambda t: t[2])
        return im, '竖版最大图 %s · %dx%d · %.0fKB' % (n, im.size[0], im.size[1], z.getinfo(n).file_size / 1024), 1.0
    n, im, a = max(imgs, key=lambda t: t[2])
    if im.size[0] > im.size[1]:
        return None, '只有横向图(%dx%d)，不适合当封面' % im.size, 0.3
    return im, '最大图 %s · %dx%d' % (n, im.size[0], im.size[1]), 1.0


def main():
    man = json.load(open(MANIFEST, encoding='utf-8'))
    os.makedirs(OUT, exist_ok=True)
    ok = nocov = 0
    for b in man['books']:
        slug, typ, f = b['id'], b['type'], os.path.join(SRC, b['file'])
        try:
            img, rule, r = (pdf_cover(f) if typ == 'pdf' else epub_cover(f))
        except Exception as e:
            img, rule, r = None, '异常: %s' % e, 0.0
        if img is None:
            if os.path.exists(os.path.join(OUT, 'tb-%s.jpg' % slug)):
                os.remove(os.path.join(OUT, 'tb-%s.jpg' % slug))
            print('⬜ %-34s %-5s  → 用占位（%s）  %s' % (slug, typ, rule, b['titleCn']))
            nocov += 1
            report[slug] = {'cover': None, 'rule': rule, 'title': b['titleCn']}
        else:
            p = save(img, slug)
            print('✅ %-34s %-5s  %s  %4.0fKB  %s' % (slug, typ, rule, os.path.getsize(p) / 1024, b['titleCn']))
            ok += 1
            report[slug] = {'cover': 'assets/books/tb-%s.jpg' % slug, 'rule': rule, 'title': b['titleCn']}
    json.dump(report, open(r'E:/galaxy_probe/covers_report.json', 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    print('\n真封面 %d 本 / 用占位 %d 本' % (ok, nocov))

    # —— 对照图：8 列 × 4 行，每格 200 宽 ——
    CW, CH, COLS = 200, 300, 8
    rows = (len(man['books']) + COLS - 1) // COLS
    sheet = Image.new('RGB', (COLS * CW, rows * (CH + 26) + 10), (245, 246, 248))
    d = ImageDraw.Draw(sheet)
    for k, b in enumerate(man['books']):
        cx, cy = (k % COLS) * CW, (k // COLS) * (CH + 26)
        slug = b['id']
        p = os.path.join(OUT, 'tb-%s.jpg' % slug)
        if os.path.exists(p):
            im = Image.open(p).convert('RGB')
            im.thumbnail((CW - 16, CH - 16), Image.LANCZOS)
            sheet.paste(im, (cx + (CW - im.width) // 2, cy + (CH - im.height) // 2))
        else:
            d.rectangle([cx + 8, cy + 8, cx + CW - 8, cy + CH - 8], fill=(226, 228, 232))
            d.text((cx + 20, cy + CH // 2 - 10), '占位 %02d' % (k + 1), fill=(90, 95, 105))
        d.text((cx + 6, cy + CH + 4), '%02d %s' % (k + 1, b['titleCn'][:13]), fill=(30, 30, 30))
    sheet.save(SHEET)
    print('对照图:', SHEET, sheet.size)


if __name__ == '__main__':
    main()
