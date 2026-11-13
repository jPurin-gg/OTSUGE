// public/icon.svg（紺地に水色のベル）から、PWA・iOS・favicon・通知用の画像を作り直す。
//
// 使い方: frontend で `node scripts/generate-icons.mjs`
// icon.svg を変えたら実行し、public/ の生成物も一緒にコミットする。
// icon.svg は「背景の <rect> 1つ + 図柄（<path> と通知の点の <circle>）」の構成を前提にしている。

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public");
const VIEW_BOX = 512;

// maskable は、端末が円や角丸に切り抜いても図柄が欠けないように縮める。
// 切り抜かれない範囲（セーフゾーン）は中心から半径 40% の円。図柄を縮めて、輪郭にも余裕を持たせる。
const MASKABLE_SCALE = 0.8;
// 通知のバッジは 24dp 前後で表示される小さな画像。図柄を枠いっぱいに近づける。
const BADGE_SIZE = 96;
const BADGE_PADDING = 4;
// バッジは単色なので、ベルと通知の点がつながって見えないように、点のまわりをこの幅だけ抜く。
const BADGE_DOT_GAP = 22;

function attribute(element, name) {
  const match = element.match(new RegExp(`\\s${name}="([^"]*)"`));
  if (!match) throw new Error(`icon.svg の ${element} に ${name} がありません。`);
  return match[1];
}

function readSource() {
  const source = readFileSync(path.join(PUBLIC_DIR, "icon.svg"), "utf8");
  const root = source.match(/<svg\b([^>]*)>([\s\S]*)<\/svg>/);
  if (!root || attribute(`<svg${root[1]}>`, "viewBox") !== `0 0 ${VIEW_BOX} ${VIEW_BOX}`) {
    throw new Error(`icon.svg は viewBox="0 0 ${VIEW_BOX} ${VIEW_BOX}" の <svg> である必要があります。`);
  }
  const elements = root[2].match(/<[a-z]+\b[^>]*\/>/g) || [];
  const background = elements.find((element) => element.startsWith("<rect"));
  const dot = elements.find((element) => element.startsWith("<circle"));
  if (!background || !dot) throw new Error("icon.svg に背景の <rect> と通知の点の <circle> が必要です。");
  return {
    backgroundColor: attribute(background, "fill"),
    background,
    dot,
    // 図柄のうち、通知の点を除いた部分（ベル本体と舌）。
    bell: elements.filter((element) => element !== background && element !== dot),
  };
}

function svg(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_BOX} ${VIEW_BOX}">${body}</svg>`;
}

function scaledAroundCenter(body, scale) {
  const center = VIEW_BOX / 2;
  return `<g transform="translate(${center} ${center}) scale(${scale}) translate(${-center} ${-center})">${body}</g>`;
}

function render(markup, size) {
  // 幅と高さを指定して、その大きさで直接ラスター化する（大きく描いてから縮めるより輪郭がぼけない）。
  const sized = markup.replace("<svg ", `<svg width="${size}" height="${size}" `);
  return sharp(Buffer.from(sized));
}

function png(image) {
  return image.png({ compressionLevel: 9 }).toBuffer();
}

// 角を透過した角丸のアイコン（icon.svg そのまま）。ブラウザのタブ、manifest の any、通知の icon に使う。
function roundedIcon(source, size) {
  return png(render(svg([source.background, ...source.bell, source.dot].join("")), size));
}

// 全面を背景色で塗った正方形のアイコン。角は表示する側（iOS・Android）が丸める。
// iOS は透過部分を黒で塗るので、アルファチャンネル自体を持たせない。
function squareIcon(source, size, scale = 1) {
  const glyph = scaledAroundCenter([...source.bell, source.dot].join(""), scale);
  const body = `<rect width="${VIEW_BOX}" height="${VIEW_BOX}" fill="${source.backgroundColor}"/>${glyph}`;
  return png(render(svg(body), size).flatten({ background: source.backgroundColor }));
}

// 通知のバッジ。Android は形（アルファ値）だけを使うので、背景は透過、図柄は白の単色にする。
async function badge(source) {
  const white = (element) => element.replace(/\sfill="[^"]*"/, ' fill="#fff"');
  const gap = Number(attribute(source.dot, "r")) + BADGE_DOT_GAP;
  const knockout = `<circle cx="${attribute(source.dot, "cx")}" cy="${attribute(source.dot, "cy")}" r="${gap}" fill="#000"/>`;
  const body = [
    `<mask id="bell"><rect width="${VIEW_BOX}" height="${VIEW_BOX}" fill="#fff"/>${knockout}</mask>`,
    `<g mask="url(#bell)">${source.bell.map(white).join("")}</g>`,
    white(source.dot),
  ].join("");

  const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
  const inner = BADGE_SIZE - BADGE_PADDING * 2;
  // 大きく描いて図柄の外接矩形で切り出し、枠に収まる大きさへ縮めて中央に置く。
  const trimmed = await render(svg(body), VIEW_BOX * 2).trim().png().toBuffer();
  const fitted = await sharp(trimmed).resize(inner, inner, { fit: "contain", background: transparent }).png().toBuffer();
  const { data, info } = await sharp(fitted)
    .extend({ top: BADGE_PADDING, bottom: BADGE_PADDING, left: BADGE_PADDING, right: BADGE_PADDING, background: transparent })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // 輪郭のにじみで色が混ざらないよう、色は白に固定してアルファ値だけを残す。
  for (let offset = 0; offset < data.length; offset += 4) data.fill(255, offset, offset + 3);
  return png(sharp(data, { raw: info }));
}

// PNG をそのまま格納した .ico。
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // 種別: アイコン
  header.writeUInt16LE(images.length, 4);
  let offset = header.length + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size, 0);
    entry.writeUInt8(size, 1);
    entry.writeUInt16LE(1, 4); // カラープレーン数
    entry.writeUInt16LE(32, 6); // 1ピクセルあたりのビット数
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

const source = readSource();
const files = {
  "icon-192.png": await roundedIcon(source, 192),
  "icon-512.png": await roundedIcon(source, 512),
  "icon-maskable-192.png": await squareIcon(source, 192, MASKABLE_SCALE),
  "icon-maskable-512.png": await squareIcon(source, 512, MASKABLE_SCALE),
  "apple-touch-icon.png": await squareIcon(source, 180),
  "notification-badge.png": await badge(source),
  "favicon.ico": ico(
    await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await roundedIcon(source, size) }))),
  ),
};

for (const [name, data] of Object.entries(files)) {
  writeFileSync(path.join(PUBLIC_DIR, name), data);
  console.log(`${name}\t${data.length} bytes`);
}
