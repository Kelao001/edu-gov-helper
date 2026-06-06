const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { buildReplyMessage, parseQQMessage } = require("./core");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const ADMIN_URL = "http://www.edu-gov.cn/ucms/index.php?do=list_add&cid=8";
const PUBLIC_HOME_URL = "http://www.edu-gov.cn/";
const USER_DATA_DIR = process.env.PW_USER_DATA_DIR || path.join(__dirname, "..", ".playwright-user-data");
const HEADLESS = process.env.HEADLESS === "1";
const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL || "msedge";
const MOBILE_TOKEN = process.env.MOBILE_TOKEN || "20050804";
const ADMIN_LOGIN = {
  username: process.env.EDUGOV_USER || "admin",
  password: process.env.EDUGOV_PASS || "Zhjyw2020"
};
const MAX_SOURCE_HOPS = 3;
const MIN_ARTICLE_TEXT_LENGTH = 80;
const STEP_TIMEOUT_MS = 45000;
const PUBLIC_SEARCH_TIMEOUT_MS = 90000;

const state = {
  running: false,
  status: "Idle",
  error: "",
  result: null,
  source: null,
  logs: [],
  startedAt: "",
  finishedAt: ""
};

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/") {
      sendHtml(response, isAuthenticated(request) ? renderHome() : renderLogin());
      return;
    }

    if (request.method === "POST" && request.url === "/api/login") {
      const body = await readJson(request);
      if (String(body.token || "") !== MOBILE_TOKEN) {
        sendJson(response, { ok: false, error: "Password is incorrect." }, 401);
        return;
      }
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "set-cookie": buildAuthCookie()
      });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (!isAuthenticated(request)) {
      sendJson(response, { ok: false, error: "Unauthorized." }, 401);
      return;
    }

    if (request.method === "GET" && request.url === "/api/state") {
      sendJson(response, snapshot());
      return;
    }

    if (request.method === "POST" && request.url === "/api/start") {
      const body = await readJson(request);
      if (state.running) {
        sendJson(response, { ok: false, error: "A task is already running." }, 409);
        return;
      }
      startJob(String(body.message || ""));
      sendJson(response, { ok: true, state: snapshot() });
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  } catch (error) {
    sendJson(response, { ok: false, error: error.message || String(error) }, 500);
  }
});

server.listen(PORT, HOST, () => {
  const urls = getLanUrls(PORT);
  console.log(`Mobile publish helper is running.`);
  console.log(`Open on this computer: http://127.0.0.1:${PORT}`);
  urls.forEach((url) => console.log(`Open on phone: ${url}`));
});

function startJob(message) {
  resetState();
  state.running = true;
  state.startedAt = new Date().toISOString();
  runPublishJob(message)
    .then((result) => {
      state.result = result;
      state.status = "Done";
    })
    .catch((error) => {
      state.error = error.message || String(error);
      state.status = "Error";
    })
    .finally(() => {
      state.running = false;
      state.finishedAt = new Date().toISOString();
    });
}

async function runPublishJob(message) {
  updateStatus("Parsing QQ message");
  const parsed = parseQQMessage(message);
  state.source = parsed;

  updateStatus("Launching browser");
  const context = await launchContext();
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  page.on("dialog", async (dialog) => {
    updateStatus(`Accepted dialog: ${dialog.message()}`);
    await dialog.accept().catch(() => {});
  });

  try {
    updateStatus("Opening source article");
    const article = await extractArticleFollowingNestedLinks(page, parsed.sourceUrl);
    const title = article.title || parsed.title;
    if (!title) {
      throw new Error("No title found in QQ message or source article.");
    }
    if (!article.contentHtml) {
      throw new Error("Could not extract article body.");
    }

    updateStatus("Opening edu-gov admin");
    await page.goto(ADMIN_URL, { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT_MS });
    await page.waitForLoadState("load", { timeout: STEP_TIMEOUT_MS }).catch(() => {});

    if (await isLoginPage(page)) {
      updateStatus("Logging in to admin");
      await loginAdmin(page);
      await page.goto(ADMIN_URL, { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT_MS });
      await page.waitForLoadState("load", { timeout: STEP_TIMEOUT_MS }).catch(() => {});
    }

    updateStatus("Filling admin editor");
    let fillResult = await page.evaluate(fillOrEnterAdminEditor, { title, contentHtml: article.contentHtml });
    if (fillResult?.needLogin) {
      updateStatus("Logging in to admin");
      await loginAdmin(page);
      await page.goto(ADMIN_URL, { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT_MS });
      await page.waitForLoadState("load", { timeout: STEP_TIMEOUT_MS }).catch(() => {});
      fillResult = await page.evaluate(fillOrEnterAdminEditor, { title, contentHtml: article.contentHtml });
    }
    if (fillResult?.clickedAddLink) {
      await page.waitForLoadState("load", { timeout: STEP_TIMEOUT_MS }).catch(() => {});
      fillResult = await page.evaluate(fillOrEnterAdminEditor, { title, contentHtml: article.contentHtml });
    }
    if (!fillResult?.filled) {
      throw new Error(fillResult?.message || "Could not fill admin editor.");
    }

    updateStatus(`Publishing via ${fillResult.editor}`);
    const publishResult = await page.evaluate(clickAdminPublishButton);
    if (!publishResult?.clicked) {
      throw new Error(publishResult?.message || "Could not click Add.");
    }
    await waitForPublishResult(page);

    updateStatus("Searching public site for exact title");
    const linkResult = await findPublishedArticleOnPublicSite(title);
    if (!linkResult?.publishedUrl) {
      throw new Error(linkResult?.error || "Published article was not found on public site.");
    }

    const replyMessage = buildReplyMessage(title, linkResult.publishedUrl, parsed.siteName);
    updateStatus("Completed");
    return {
      title,
      publishedUrl: linkResult.publishedUrl,
      replyMessage,
      sourceUrl: article.finalUrl || parsed.sourceUrl,
      searchSource: linkResult.source,
      hops: article.hops || []
    };
  } finally {
    if (process.env.KEEP_BROWSER_OPEN !== "1") {
      await context.close().catch(() => {});
    }
  }
}

async function launchContext() {
  const options = {
    headless: HEADLESS,
    viewport: { width: 1366, height: 900 }
  };
  try {
    return await chromium.launchPersistentContext(USER_DATA_DIR, { ...options, channel: BROWSER_CHANNEL });
  } catch (error) {
    updateStatus(`Browser channel ${BROWSER_CHANNEL} unavailable; using bundled chromium`);
    return chromium.launchPersistentContext(USER_DATA_DIR, options);
  }
}

async function isLoginPage(page) {
  return await page.locator("input[type='password'], #uuu_password").count().then((count) => count > 0).catch(() => false);
}

async function loginAdmin(page) {
  await page.fill("#uuu_username, input[name='uuu_username'], input[type='text']", ADMIN_LOGIN.username);
  await page.fill("#uuu_password, input[name='uuu_password'], input[type='password']", ADMIN_LOGIN.password);
  await Promise.all([
    page.waitForLoadState("load", { timeout: STEP_TIMEOUT_MS }).catch(() => {}),
    page.click("input[type='submit'], button:has-text('登录')")
  ]);
  if (await isLoginPage(page)) {
    throw new Error("Admin login did not complete.");
  }
}

async function extractArticleFollowingNestedLinks(page, sourceUrl) {
  const hops = [];
  let currentUrl = sourceUrl;

  for (let index = 0; index < MAX_SOURCE_HOPS; index += 1) {
    await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT_MS });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    const article = await page.evaluate(extractArticleFromSourcePage, MIN_ARTICLE_TEXT_LENGTH);
    hops.push(page.url());

    if (article?.contentHtml) {
      return { ...article, finalUrl: page.url(), hops };
    }
    if (!article?.nestedUrl) {
      throw new Error(article?.message || "No article body or nested article link found.");
    }
    currentUrl = article.nestedUrl;
    updateStatus(`Following nested source link ${index + 1}`);
  }

  throw new Error("Too many nested source links.");
}

async function waitForPublishResult(page) {
  const startedAt = Date.now();
  await page.waitForLoadState("load", { timeout: STEP_TIMEOUT_MS }).catch(() => {});

  while (Date.now() - startedAt < STEP_TIMEOUT_MS) {
    const result = await page.evaluate(detectPublishResultPage).catch(() => null);
    if (result?.ready) return;
    await page.waitForTimeout(1000);
  }

  throw new Error("Publish result timed out.");
}

async function findPublishedArticleOnPublicSite(title) {
  const startedAt = Date.now();
  const cleanTarget = normalizeText(title);
  const searchUrl = `${PUBLIC_HOME_URL}?s=${encodeURIComponent(title)}`;

  while (Date.now() - startedAt < PUBLIC_SEARCH_TIMEOUT_MS) {
    for (const attempt of [{ url: searchUrl, source: "public-search" }, { url: PUBLIC_HOME_URL, source: "public-home" }]) {
      const html = await fetchText(attempt.url).catch(() => "");
      const matched = findExactTitleLinkInHtml(html, cleanTarget);
      if (matched?.publishedUrl) {
        return { publishedUrl: matched.publishedUrl, source: attempt.source };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }

  return { error: "Public site search did not find the newly published title." };
}

async function fetchText(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
  return response.text();
}

function findExactTitleLinkInHtml(html, cleanTarget) {
  const links = [];
  const anchorPattern = /<a\b[^>]*href\s*=\s*(['"])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(html))) {
    const href = decodeHtml(match[2]);
    const text = normalizeText(stripTags(match[3]));
    if (text !== cleanTarget) continue;
    let publishedUrl = "";
    try {
      publishedUrl = new URL(href, PUBLIC_HOME_URL).href;
    } catch (_error) {
      continue;
    }
    if (!/\/edu\/\d+\.html(?:$|[?#])/i.test(publishedUrl)) continue;
    links.push({ publishedUrl, id: Number((publishedUrl.match(/\/edu\/(\d+)\.html/i) || [])[1] || 0) });
  }
  return links.sort((a, b) => b.id - a.id)[0] || null;
}

function extractArticleFromSourcePage(minTextLength) {
  function cleanText(node) {
    return (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function absoluteHtml(container) {
    const clone = container.cloneNode(true);
    clone.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src") || img.getAttribute("data-src");
      if (src) img.setAttribute("src", new URL(src, location.href).href);
      img.removeAttribute("class");
      img.removeAttribute("data-src");
      img.removeAttribute("loading");
    });
    clone.querySelectorAll("script, style, button, .btn, .btntitle, [onclick*='Copy']").forEach((node) => node.remove());
    return clone.innerHTML.trim();
  }

  function scoreContentNode(node) {
    const textLength = cleanText(node).length;
    const paragraphCount = node.querySelectorAll("p").length;
    const imageCount = node.querySelectorAll("img").length;
    const linkCount = node.querySelectorAll("a").length;
    const idClass = `${node.id || ""} ${node.className || ""}`.toLowerCase();
    let score = textLength + paragraphCount * 80 + imageCount * 60 - linkCount * 20;
    if (/mycontent|article|content|main|text|body|detail|news/.test(idClass)) score += 500;
    if (/nav|menu|foot|head|side|comment|share|related/.test(idClass)) score -= 500;
    return score;
  }

  function findContentNode() {
    const exact = document.querySelector("#mycontent");
    if (exact) return exact;
    const selectors = ["#articleContent", "#copy_area", "article", ".TRS_Editor", ".rich_media_content", ".article-content", ".article_content", ".content", ".main-content", ".detail", "#content", "#article", "#main"];
    const candidates = selectors
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .filter((node, index, list) => list.indexOf(node) === index);
    if (!candidates.length) return null;
    return candidates.map((node) => ({ node, score: scoreContentNode(node) })).sort((a, b) => b.score - a.score)[0]?.node || null;
  }

  function findNestedArticleLink() {
    function normalizeUrl(rawUrl) {
      const cleaned = String(rawUrl || "").replace(/\\\//g, "/").replace(/&amp;/g, "&").replace(/[\\'")\]}>,\uFF0C\u3002\uFF1B;]+$/g, "");
      try {
        return new URL(cleaned, location.href).href;
      } catch (_error) {
        return "";
      }
    }

    function isUsableNestedUrl(url) {
      if (!/^https?:\/\//i.test(url)) return false;
      if (url.replace(/#.*$/, "") === location.href.replace(/#.*$/, "")) return false;
      if (/\.(?:js|css|png|jpe?g|gif|webp|svg|ico|mp4|mp3|pdf|zip)(?:[?#]|$)/i.test(url)) return false;
      if (/\/(?:static|assets|images?|css|js)\//i.test(url)) return false;
      return true;
    }

    function nestedUrlScore(item) {
      const haystack = `${item.text || ""} ${item.url}`;
      let score = 0;
      if (/article|detail|news|content|show/i.test(haystack)) score += 80;
      if (/[?&]id=\d+/i.test(haystack)) score += 40;
      if (/\u539f\u6587|\u94fe\u63a5|\u70b9\u51fb|\u67e5\u770b|\u8be6\u60c5|\u9605\u8bfb|\u7a3f\u4ef6|\u6587\u7ae0/.test(haystack)) score += 40;
      if (/edu-gov|cnmtpt|hebeirongshi|gaoduanedu/i.test(haystack)) score += 20;
      if (/login|register|share|download|static/i.test(haystack)) score -= 80;
      return score;
    }

    const anchors = Array.from(document.querySelectorAll("a[href]"))
      .map((node) => {
        const url = normalizeUrl(node.getAttribute("href"));
        const text = cleanText(node);
        const visible = Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length);
        if (!visible || !isUsableNestedUrl(url)) return null;
        return { url, text };
      })
      .filter(Boolean);
    const scriptText = Array.from(document.scripts).map((script) => script.textContent || "").join("\n");
    const rawUrls = `${document.documentElement.innerHTML}\n${scriptText}`.match(/https?:\\?\/\\?\/[^'"<>\s]+/ig) || [];
    const scriptUrls = rawUrls
      .map((url) => ({ url: normalizeUrl(url), text: "" }))
      .filter((item, index, list) => item.url && isUsableNestedUrl(item.url) && list.findIndex((other) => other.url === item.url) === index);
    const pageText = cleanText(document.body);
    const articleLike = anchors.concat(scriptUrls).map((item) => ({ ...item, score: nestedUrlScore(item) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
    if (articleLike.length === 1) return articleLike[0].url;
    if (anchors.length === 1 && pageText.length < 500) return anchors[0].url;
    return articleLike[0]?.url || "";
  }

  function contentMetrics(node) {
    if (!node) return { textLength: 0, paragraphs: 0, listItems: 0, divBlocks: 0, images: 0 };
    const divBlocks = Array.from(node.querySelectorAll("div")).filter((item) => cleanText(item).length >= 20 && item.querySelectorAll("div, p, li").length <= 2).length;
    return {
      textLength: cleanText(node).length,
      paragraphs: node.querySelectorAll("p").length,
      listItems: node.querySelectorAll("li").length,
      divBlocks,
      images: node.querySelectorAll("img").length
    };
  }

  const titleNode = document.querySelector("#mytitle") || document.querySelector("#articleTitle") || document.querySelector("#title") || document.querySelector("h1") || document.querySelector(".title") || document.querySelector("[class*='title']");
  const contentNode = findContentNode();
  const nestedUrl = findNestedArticleLink();
  const metrics = contentMetrics(contentNode);
  const hasArticleBlocks = metrics.paragraphs >= 2 || metrics.listItems >= 2 || metrics.divBlocks >= 3 || metrics.images >= 1;
  const hasEmptyPreviewBody = Boolean(document.querySelector("#copy_area")) && cleanText(document.querySelector("#copy_area")).length < minTextLength;
  const hasRealBody = Boolean(contentNode) && metrics.textLength >= minTextLength && hasArticleBlocks && !hasEmptyPreviewBody;
  if (!hasRealBody) {
    return { title: cleanText(titleNode) || document.title, contentHtml: "", contentTextLength: metrics.textLength, nestedUrl, message: "Source page does not contain enough body text." };
  }
  return { title: cleanText(titleNode) || document.title, contentHtml: absoluteHtml(contentNode), contentTextLength: metrics.textLength, nestedUrl: "" };
}

async function fillOrEnterAdminEditor(article) {
  if (/login\.php/i.test(location.href) || document.querySelector("input[type='password']")) {
    return { needLogin: true };
  }

  const editable = findTitleInput() || findAddLink();
  if (editable?.kind === "add-link") {
    editable.node.click();
    return { clickedAddLink: true };
  }

  const titleInput = editable?.node || findTitleInput()?.node;
  const contentResult = await setEditorContent(article.contentHtml);
  if (!titleInput || !contentResult.ok) {
    return { filled: false, message: !titleInput ? "Title input not found." : contentResult.message };
  }

  setNativeValue(titleInput, article.title);
  return { filled: true, editor: contentResult.editor };

  function findAddLink() {
    const candidates = Array.from(document.querySelectorAll("a, button, input[type='button'], input[type='submit']"));
    const addNode = candidates.find((node) => {
      const text = (node.innerText || node.value || node.title || "").trim();
      return text === "\u6dfb\u52a0" || text.includes("\u6dfb\u52a0");
    });
    return addNode ? { kind: "add-link", node: addNode } : null;
  }

  function findTitleInput() {
    const inputs = Array.from(document.querySelectorAll("input[type='text'], input:not([type]), textarea"));
    const scored = inputs.map((node) => {
      const haystack = [node.name, node.id, node.placeholder, node.getAttribute("aria-label")].filter(Boolean).join(" ").toLowerCase();
      let score = 0;
      if (/title|bt|subject|\u6807\u9898/.test(haystack)) score += 10;
      if (node.tagName === "TEXTAREA") score -= 3;
      if (node.offsetParent !== null) score += 2;
      return { node, score };
    }).sort((a, b) => b.score - a.score);
    return scored[0]?.score > 0 ? { kind: "title", node: scored[0].node } : null;
  }

  async function setEditorContent(html) {
    const editors = [];
    const ueCount = await setUEditors(html);
    if (ueCount) editors.push(`ueditor:${ueCount}`);
    const iframeCount = setEditorIframes(html);
    if (iframeCount) editors.push(`iframe:${iframeCount}`);
    const editableCount = setContentEditables(html);
    if (editableCount) editors.push(`contenteditable:${editableCount}`);
    const textareaCount = setContentTextareas(html);
    if (textareaCount) editors.push(`textarea:${textareaCount}`);
    if (!editors.length) return { ok: false, message: "Body editor not found." };
    return { ok: true, editor: editors.join(",") };
  }

  async function setUEditors(html) {
    if (!window.UE?.getEditor) return 0;
    const ids = new Set();
    Object.keys(window.UE.instants || {}).forEach((id) => ids.add(id));
    Array.from(document.querySelectorAll("script[id], textarea[id]")).forEach((node) => ids.add(node.id));
    ["editor", "content", "myEditor", "container"].forEach((id) => ids.add(id));
    let count = 0;
    for (const id of ids) {
      try {
        const editor = window.UE.getEditor(id);
        if (!editor?.setContent) continue;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 2500);
          editor.ready(() => {
            clearTimeout(timer);
            resolve();
          });
        });
        editor.setContent(html, false);
        editor.sync?.();
        count += 1;
      } catch (_error) {}
    }
    return count;
  }

  function setEditorIframes(html) {
    let count = 0;
    Array.from(document.querySelectorAll("iframe")).forEach((frame) => {
      try {
        const doc = frame.contentDocument;
        const body = doc?.body;
        if (!body) return;
        const idClass = `${frame.id || ""} ${frame.name || ""} ${frame.className || ""}`.toLowerCase();
        const likelyEditor = /editor|content|ueditor|edui|body|text/.test(idClass) || body.isContentEditable || doc.designMode === "on";
        if (!likelyEditor) return;
        body.innerHTML = html;
        body.dispatchEvent(new Event("input", { bubbles: true }));
        body.dispatchEvent(new Event("change", { bubbles: true }));
        count += 1;
      } catch (_error) {}
    });
    return count;
  }

  function setContentEditables(html) {
    const editables = Array.from(document.querySelectorAll("[contenteditable='true'], [contenteditable='']"));
    let count = 0;
    editables.forEach((node) => {
      const idClass = `${node.id || ""} ${node.className || ""}`.toLowerCase();
      const text = (node.innerText || "").trim();
      const likelyEditor = /editor|content|ueditor|body|text/.test(idClass) || text.length > 20 || editables.length === 1;
      if (!likelyEditor) return;
      node.innerHTML = html;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      count += 1;
    });
    return count;
  }

  function setContentTextareas(html) {
    const textareas = Array.from(document.querySelectorAll("textarea"));
    const targets = textareas.filter((node) => {
      const haystack = [node.name, node.id, node.placeholder, node.getAttribute("aria-label")].filter(Boolean).join(" ").toLowerCase();
      return /content|body|text|editor|article|\u6b63\u6587|\u5185\u5bb9/.test(haystack);
    });
    const fallback = targets.length ? targets : textareas.length === 1 ? textareas : [];
    fallback.forEach((node) => setNativeValue(node, html));
    return fallback.length;
  }

  function setNativeValue(node, value) {
    node.focus?.();
    node.value = value;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function clickAdminPublishButton() {
  syncEditorsBeforeSubmit();
  const candidates = Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit'], input[type='image'], a"));
  const scored = candidates.map((node) => {
    const label = (node.innerText || node.value || node.title || node.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    let score = 0;
    if (label === "\u589e\u52a0") score += 100;
    if (label.includes("\u589e\u52a0")) score += 60;
    if (/\u63d0\u4ea4|\u4fdd\u5b58|\u53d1\u5e03|\u786e\u5b9a/.test(label)) score += 30;
    if (label.includes("\u6dfb\u52a0")) score -= 100;
    if (label.includes("\u6d4f\u89c8")) score -= 100;
    if (node.type === "submit") score += 20;
    if (node.offsetParent !== null) score += 10;
    return { node, label, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
  const target = scored[0];
  if (target) {
    target.node.scrollIntoView?.({ block: "center", inline: "center" });
    target.node.click();
    return { clicked: true, label: target.label, score: target.score };
  }
  const form = Array.from(document.forms).find((item) => item.querySelector("textarea, iframe, [contenteditable='true']")) || document.forms[0];
  if (form) {
    form.requestSubmit?.();
    if (!form.requestSubmit) form.submit();
    return { clicked: true, label: "form.submit", score: 1 };
  }
  return { clicked: false, message: "Add button not found." };

  function syncEditorsBeforeSubmit() {
    try {
      Object.values(window.UE?.instants || {}).forEach((editor) => editor?.sync?.());
    } catch (_error) {}
    document.querySelectorAll("textarea, input").forEach((node) => {
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
}

function detectPublishResultPage() {
  const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
  const hasBrowse = Array.from(document.querySelectorAll("a, button, input[type='button'], input[type='submit']")).some((node) => {
    const label = (node.innerText || node.value || node.title || "").trim();
    return label === "\u6d4f\u89c8" || label.includes("\u6d4f\u89c8");
  });
  const isPublishedArticle = /\/edu\/\d+\.html(?:$|[?#])/i.test(location.href);
  const hasSuccessText = /\u6210\u529f|\u589e\u52a0\u6210\u529f|\u53d1\u5e03\u6210\u529f/.test(text);
  const hasFormEditor = Boolean(document.querySelector("textarea, iframe, [contenteditable='true']"));
  return { ready: hasBrowse || isPublishedArticle || hasSuccessText || (!hasFormEditor && text.length > 0) };
}

function stripTags(html) {
  return String(html || "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, "");
}

function decodeHtml(text) {
  return String(text || "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function normalizeText(text) {
  return decodeHtml(text).replace(/\s+/g, " ").trim();
}

function resetState() {
  state.running = false;
  state.status = "Idle";
  state.error = "";
  state.result = null;
  state.source = null;
  state.logs = [];
  state.startedAt = "";
  state.finishedAt = "";
}

function updateStatus(status) {
  state.status = status;
  state.logs.push({ time: new Date().toISOString(), status });
  if (state.logs.length > 80) state.logs.shift();
}

function snapshot() {
  return { ...state };
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        request.destroy();
        reject(new Error("Request body too large."));
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, data, statusCode = 200) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(data));
}

function sendHtml(response, html) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(html);
}

function isAuthenticated(request) {
  const cookies = parseCookies(request.headers.cookie || "");
  return cookies.edugov_mobile_token === MOBILE_TOKEN;
}

function parseCookies(cookieHeader) {
  return String(cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf("=");
      if (index === -1) return cookies;
      cookies[decodeURIComponent(part.slice(0, index))] = decodeURIComponent(part.slice(index + 1));
      return cookies;
    }, {});
}

function buildAuthCookie() {
  const maxAge = 60 * 60 * 24 * 30;
  return `edugov_mobile_token=${encodeURIComponent(MOBILE_TOKEN)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
}

function renderLogin() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>登录发稿助手</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; color: #202124; background: #f7f7f4; }
    body { margin: 0; }
    main { max-width: 420px; margin: 0 auto; padding: 24px 16px; display: grid; gap: 12px; }
    h1 { margin: 4px 0; font-size: 22px; }
    input { height: 42px; border: 1px solid #c9c9c3; border-radius: 8px; padding: 0 10px; font: inherit; background: #fff; }
    button { height: 42px; border: 0; border-radius: 8px; background: #e86b18; color: #fff; font-weight: 700; font-size: 15px; }
    .error { color: #b3261e; min-height: 20px; }
  </style>
</head>
<body>
  <main>
    <h1>登录发稿助手</h1>
    <input id="token" type="password" placeholder="输入访问密码" autocomplete="current-password">
    <button id="login">进入</button>
    <span id="error" class="error"></span>
  </main>
  <script>
    const token = document.querySelector("#token");
    const login = document.querySelector("#login");
    const error = document.querySelector("#error");
    login.addEventListener("click", submit);
    token.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
    });
    async function submit() {
      error.textContent = "";
      login.disabled = true;
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token.value })
      }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
      login.disabled = false;
      if (response.ok) {
        location.reload();
      } else {
        error.textContent = response.error || "登录失败";
      }
    }
  </script>
</body>
</html>`;
}

function renderHome() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>中华教育网手机发稿助手</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; color: #202124; background: #f7f7f4; }
    body { margin: 0; }
    main { max-width: 760px; margin: 0 auto; padding: 16px; display: grid; gap: 12px; }
    h1 { margin: 4px 0; font-size: 22px; }
    textarea { box-sizing: border-box; width: 100%; min-height: 150px; resize: vertical; border: 1px solid #c9c9c3; border-radius: 8px; padding: 10px; line-height: 1.55; font: inherit; background: #fff; }
    #result { min-height: 96px; }
    button { height: 42px; border: 0; border-radius: 8px; background: #e86b18; color: #fff; font-weight: 700; font-size: 15px; }
    button.secondary { background: #275d8c; }
    button:disabled { opacity: .65; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .panel { border: 1px solid #d9d6cc; border-radius: 8px; background: #fffdf7; padding: 10px; display: grid; gap: 6px; }
    .error { color: #b3261e; word-break: break-word; }
    .logs { max-height: 180px; overflow: auto; font-size: 12px; color: #5f6368; white-space: pre-wrap; }
  </style>
</head>
<body>
  <main>
    <h1>中华教育网手机发稿助手</h1>
    <textarea id="message" placeholder="粘贴含稿件链接的 QQ 消息即可；标题和尾部文字可有可无"></textarea>
    <div class="actions">
      <button id="start">开始发稿</button>
      <button id="copy" class="secondary">复制结果</button>
    </div>
    <section class="panel">
      <strong id="status">Idle</strong>
      <span id="error" class="error"></span>
    </section>
    <textarea id="result" readonly placeholder="完成后回传消息会显示在这里"></textarea>
    <section class="panel logs" id="logs"></section>
  </main>
  <script>
    const message = document.querySelector("#message");
    const start = document.querySelector("#start");
    const copy = document.querySelector("#copy");
    const statusNode = document.querySelector("#status");
    const errorNode = document.querySelector("#error");
    const result = document.querySelector("#result");
    const logs = document.querySelector("#logs");

    start.addEventListener("click", async () => {
      errorNode.textContent = "";
      result.value = "";
      start.disabled = true;
      await fetch("/api/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: message.value })
      }).then((r) => r.json()).then(render).catch((e) => errorNode.textContent = e.message);
      poll();
    });

    copy.addEventListener("click", async () => {
      if (!result.value) return;
      await navigator.clipboard.writeText(result.value).catch(() => {});
    });

    async function poll() {
      const data = await fetch("/api/state").then((r) => r.json());
      render(data);
    }

    function render(data) {
      statusNode.textContent = data.status || "Idle";
      errorNode.textContent = data.error || "";
      start.disabled = Boolean(data.running);
      if (data.result?.replyMessage) result.value = data.result.replyMessage;
      logs.textContent = (data.logs || []).map((item) => \`\${item.time}  \${item.status}\`).join("\\n");
    }

    poll();
    setInterval(poll, 1200);
  </script>
</body>
</html>`;
}

function getLanUrls(port) {
  const urls = [];
  for (const values of Object.values(os.networkInterfaces())) {
    for (const item of values || []) {
      if (item.family === "IPv4" && !item.internal) {
        urls.push(`http://${item.address}:${port}`);
      }
    }
  }
  return urls;
}
