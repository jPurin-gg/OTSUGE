import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import Home from "../app/page";

// manifest・アイコン・通知の画像が1系統（紺地に水色のベル）にそろっていることを、public/ の実ファイルで検証する。
// 画像は scripts/generate-icons.mjs が public/icon.svg から作る。

const PUBLIC_DIR = path.join(process.cwd(), "public");
const NAVY = [15, 23, 42]; // icon.svg の背景 #0f172a
const CYAN = [103, 232, 249]; // icon.svg のベル #67e8f9

type ManifestIcon = { src: string; sizes: string; type: string; purpose: string };
type Manifest = { lang: string; background_color: string; theme_color: string; icons: ManifestIcon[] };

const manifest: Manifest = JSON.parse(readFileSync(path.join(PUBLIC_DIR, "manifest.json"), "utf8"));

function publicFile(url: string) {
  assert.match(url, /^\/[\w.-]+$/, `${url} は public/ 直下のファイルを指していない`);
  const file = path.join(PUBLIC_DIR, url);
  assert.ok(existsSync(file), `public${url} がない`);
  return file;
}

type Pixels = { width: number; height: number; at: (x: number, y: number) => number[] };

async function pixels(input: string | Buffer): Promise<Pixels> {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    at: (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)],
  };
}

function everyPixel(image: Pixels, check: (rgba: number[], x: number, y: number) => void) {
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) check(image.at(x, y), x, y);
  }
}

// 紺の背景の中央に水色のベルがあること。上端寄りの中央は背景、画像の中心はベルの胴になる。
function assertNavyBell(image: Pixels, label: string) {
  const center = Math.floor(image.width / 2);
  assert.deepEqual(image.at(center, Math.floor(image.height * 0.08)), [...NAVY, 255], `${label} の背景が紺ではない`);
  assert.deepEqual(image.at(center, Math.floor(image.height / 2)), [...CYAN, 255], `${label} の中央が水色のベルではない`);
}

// .ico に格納された画像（PNG）を取り出す。
function icoImages(file: string) {
  const data = readFileSync(file);
  assert.deepEqual([data.readUInt16LE(0), data.readUInt16LE(2)], [0, 1], "favicon.ico のヘッダーが .ico ではない");
  return Array.from({ length: data.readUInt16LE(4) }, (_, index) => {
    const entry = 6 + index * 16;
    const offset = data.readUInt32LE(entry + 12);
    return { size: data.readUInt8(entry), data: data.subarray(offset, offset + data.readUInt32LE(entry + 8)) };
  });
}

// layout.tsx は CSS を import しているので、CSS だけ空のモジュールに差し替えて読み込む。
async function loadLayout() {
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith(".css")) return { format: "commonjs", source: "", shortCircuit: true };
      return nextLoad(url, context);
    },
  });
  try {
    return await import("../app/layout");
  } finally {
    hooks.deregister();
  }
}

type IconLink = { url: string; sizes?: string; type?: string };

async function layoutIcons() {
  const { metadata } = await loadLayout();
  const icons = metadata.icons as { icon: IconLink[]; apple: IconLink[] } | undefined;
  assert.ok(icons, "layout.tsx の metadata に icons がない");
  return icons;
}

// public/sw.js を実行して push を届け、showNotification に渡された内容を返す。
async function shownNotification() {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const shown: { title: string; options: { icon: string; badge: string } }[] = [];
  const self = {
    location: new URL("https://otsuge.test/sw.js"),
    addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => listeners.set(type, listener),
    skipWaiting: () => {},
    clients: { claim: async () => {} },
    registration: {
      showNotification: async (title: string, options: { icon: string; badge: string }) => {
        shown.push({ title, options });
      },
    },
  };
  vm.runInNewContext(readFileSync(path.join(PUBLIC_DIR, "sw.js"), "utf8"), { self, URL });

  const pending: Promise<unknown>[] = [];
  listeners.get("push")?.({
    data: { json: () => ({ title: "お告げ", body: "本文" }) },
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  });
  await Promise.all(pending);
  assert.equal(shown.length, 1, "push を受けても通知を表示していない");
  return shown[0].options;
}

test("public/ の manifest は manifest.json の1つだけで、layout.tsx が参照している", async () => {
  const manifests = readdirSync(PUBLIC_DIR).filter((name) => /manifest/i.test(name));
  assert.deepEqual(manifests, ["manifest.json"]);
  assert.equal((await loadLayout()).metadata.manifest, "/manifest.json");
});

test("manifest の配色は layout.tsx の themeColor・画面の背景色と一致し、lang は ja", async () => {
  const { viewport } = await loadLayout();
  const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
  const bodyBackground = css.match(/body\s*\{[^}]*background:\s*(#[0-9a-f]+)/i)?.[1];

  assert.equal(manifest.theme_color, viewport.themeColor);
  assert.equal(manifest.background_color, bodyBackground);
  const html = renderToStaticMarkup(createElement(Home));
  const mainClasses = html.match(/<main\s+class="([^"]*)"/)?.[1]?.split(" ") ?? [];
  assert.ok(mainClasses.includes(`bg-[${manifest.background_color}]`), "ホームの背景色が manifest と違う");
  assert.equal(manifest.lang, "ja");
});

test("manifest のアイコンは PNG で、any の 192 / 512 と maskable を別の画像として持つ", async () => {
  for (const icon of manifest.icons) {
    assert.equal(icon.type, "image/png", `${icon.src} が PNG ではない`);
    assert.ok(["any", "maskable"].includes(icon.purpose), `${icon.src} の purpose が any と maskable の兼用になっている`);
    const metadata = await sharp(publicFile(icon.src)).metadata();
    assert.equal(metadata.format, "png", `${icon.src} の中身が PNG ではない`);
    assert.equal(`${metadata.width}x${metadata.height}`, icon.sizes, `${icon.src} の実寸が sizes と違う`);
  }

  const sizes = (purpose: string) => manifest.icons.filter((icon) => icon.purpose === purpose).map((icon) => icon.sizes);
  assert.deepEqual(sizes("any"), ["192x192", "512x512"]);
  assert.deepEqual(sizes("maskable"), ["192x192", "512x512"]);

  const anySources = manifest.icons.filter((icon) => icon.purpose === "any").map((icon) => icon.src);
  for (const icon of manifest.icons.filter((item) => item.purpose === "maskable")) {
    assert.ok(!anySources.includes(icon.src), `${icon.src} を any と maskable で使い回している`);
  }
});

test("maskable 用のアイコンは全面が不透明で、図柄がセーフゾーン（中心から半径 40%）に収まる", async () => {
  const maskable = manifest.icons.filter((icon) => icon.purpose === "maskable");
  assert.ok(maskable.length > 0);

  for (const icon of maskable) {
    const image = await pixels(publicFile(icon.src));
    const center = (image.width - 1) / 2;
    const safeRadius = image.width * 0.4;
    assertNavyBell(image, icon.src);
    everyPixel(image, (rgba, x, y) => {
      // 角まで背景色で塗ってあること（透過があると、切り抜かれたときに欠けて見える）。
      assert.equal(rgba[3], 255, `${icon.src} の (${x}, ${y}) が透過している`);
      if (Math.hypot(x - center, y - center) <= safeRadius) return;
      assert.deepEqual(rgba.slice(0, 3), NAVY, `${icon.src} の図柄が (${x}, ${y}) でセーフゾーンの外に出ている`);
    });
  }
});

test("apple-touch-icon は 180px の不透明な PNG で、layout.tsx が参照している", async () => {
  const apple = (await layoutIcons()).apple;
  assert.deepEqual(apple, [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }]);

  const file = publicFile(apple[0].url);
  assert.equal((await sharp(file).metadata()).format, "png");
  const image = await pixels(file);
  assert.deepEqual([image.width, image.height], [180, 180]);
  assertNavyBell(image, apple[0].url);
  // iOS は透過部分を黒で塗るので、角も含めて不透明にしておく。
  everyPixel(image, (rgba, x, y) => assert.equal(rgba[3], 255, `apple-touch-icon の (${x}, ${y}) が透過している`));
});

test("favicon は 16 / 32 / 48px を含む .ico で、layout.tsx が参照している", async () => {
  const icons = (await layoutIcons()).icon;
  for (const icon of icons) publicFile(icon.url);

  const favicon = icons.find((icon) => icon.url === "/favicon.ico");
  assert.ok(favicon, "layout.tsx が /favicon.ico を参照していない");

  const images = icoImages(publicFile(favicon.url));
  assert.deepEqual(images.map((image) => image.size), [16, 32, 48]);
  assert.equal(favicon.sizes, images.map((image) => `${image.size}x${image.size}`).join(" "));
  for (const image of images) {
    const decoded = await pixels(image.data);
    assert.deepEqual([decoded.width, decoded.height], [image.size, image.size]);
    assertNavyBell(decoded, `favicon.ico の ${image.size}px`);
  }
});

test("ホーム画面のアイコン・通知のアイコン・アプリ内のロゴは、どれも紺地に水色のベル", async () => {
  const icons = await layoutIcons();
  const html = renderToStaticMarkup(createElement(Home));
  const logo = decodeURIComponent(html.match(/<img[^>]*\ssrc="([^"]+)"/)?.[1] ?? "").match(/\/[\w.-]+\.(?:png|svg)/)?.[0];
  assert.ok(logo, "ホームのヘッダーにロゴの画像がない");

  const sources = new Set([
    "/icon.svg",
    logo,
    (await shownNotification()).icon,
    ...manifest.icons.map((icon) => icon.src),
    ...icons.apple.map((icon) => icon.url),
    ...icons.icon.map((icon) => icon.url).filter((url) => !url.endsWith(".ico")),
  ]);
  for (const source of sources) assertNavyBell(await pixels(publicFile(source)), source);
});

test("通知の icon は PNG、badge は背景が透過した単色の専用画像", async () => {
  const { icon, badge } = await shownNotification();

  assert.equal((await sharp(publicFile(icon)).metadata()).format, "png", "通知の icon が PNG ではない");
  assert.notEqual(badge, icon, "badge に通知の icon と同じ画像を使っている");
  assert.equal((await sharp(publicFile(badge)).metadata()).format, "png", "通知の badge が PNG ではない");

  // Android は badge の形（アルファ値）だけを使う。背景を塗ってあると単色の四角になる。
  const image = await pixels(publicFile(badge));
  const colors = new Set<string>();
  let transparent = 0;
  let opaque = 0;
  everyPixel(image, ([red, green, blue, alpha]) => {
    if (alpha === 0) transparent += 1;
    if (alpha === 255) opaque += 1;
    if (alpha > 0) colors.add(`${red},${green},${blue}`);
  });
  const total = image.width * image.height;
  assert.deepEqual([...colors], ["255,255,255"], "badge が白の単色ではない");
  assert.ok(transparent / total > 0.3, "badge の背景が透過していない");
  assert.ok(opaque / total > 0.2, "badge に図柄がない");
  for (const [x, y] of [[0, 0], [image.width - 1, 0], [0, image.height - 1], [image.width - 1, image.height - 1]]) {
    assert.equal(image.at(x, y)[3], 0, `badge の角 (${x}, ${y}) が透過していない`);
  }
});
