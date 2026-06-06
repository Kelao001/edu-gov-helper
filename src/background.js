importScripts("core.js");

const ADMIN_URL = "http://www.edu-gov.cn/ucms/index.php?do=list_add&cid=8";
const POLL_INTERVAL_MS = 1000;
const STEP_TIMEOUT_MS = 45000;
const MAX_SOURCE_HOPS = 3;
const MIN_ARTICLE_TEXT_LENGTH = 80;
const STORAGE_KEY = "edugovState";
const PUBLIC_HOME_URL = "http://www.edu-gov.cn/";
const PUBLIC_SEARCH_TIMEOUT_MS = 90000;
const ADMIN_LOGIN = {
  username: "admin",
  password: "Zhjyw2020"
};

const state = {
  running: false,
  status: "Idle",
  error: "",
  source: null,
  article: null,
  result: null,
  currentTabId: null
};

let stateHydrated = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse);
  return true;
});

async function handleMessage(message) {
  await hydrateState();

  if (message?.type === "START_PUBLISH") {
    return startPublish(message.payload);
  }

  if (message?.type === "GET_STATE") {
    return snapshot();
  }

  if (message?.type === "COPY_RESULT") {
    return copyResultToActivePage();
  }

  return { ok: false, error: "Unknown message type." };
}

async function hydrateState() {
  if (stateHydrated) return;
  const stored = await chrome.storage.local.get(STORAGE_KEY).catch(() => ({}));
  if (stored?.[STORAGE_KEY]) {
    Object.assign(state, stored[STORAGE_KEY], { running: false });
    updateBadge(snapshot());
  }
  stateHydrated = true;
}

async function startPublish(payload) {
  if (state.running) {
    return { ok: false, error: "A task is already running." };
  }

  resetState();
  state.running = true;

  try {
    updateStatus("Parsing QQ message");
    state.source = EduGovCore.parseQQMessage(payload?.message || "");

    updateStatus("Opening source article");
    const sourceTab = await openAndWait(state.source.sourceUrl, false);
    const article = await extractArticleFollowingNestedLinks(sourceTab.id);
    await chrome.tabs.remove(sourceTab.id).catch(() => {});

    state.article = {
      title: article.title || state.source.title,
      contentHtml: article.contentHtml || "",
      sourceUrl: article.finalUrl || state.source.sourceUrl,
      hops: article.hops || []
    };
    if (!state.article.contentHtml) {
      throw new Error("Could not extract article body from source page.");
    }
    if (!state.article.title) {
      throw new Error("No title found in QQ message or source article.");
    }

    updateStatus("Opening edu-gov admin");
    const adminTab = await openAndWait(ADMIN_URL, true);
    state.currentTabId = adminTab.id;

    updateStatus("Filling admin editor");
    let fillResult = await execute(adminTab.id, fillOrEnterAdminEditor, [state.article]);
    if (fillResult?.needLogin) {
      updateStatus("Admin login required; logging in automatically");
      const loginResult = await execute(adminTab.id, autoLoginAdminPage, [ADMIN_LOGIN]);
      if (!loginResult?.submitted) {
        throw new Error(loginResult?.message || "Admin auto-login failed.");
      }
      await waitForTabComplete(adminTab.id);
      await chrome.tabs.update(adminTab.id, { url: ADMIN_URL, active: true });
      await waitForTabComplete(adminTab.id);
      fillResult = await execute(adminTab.id, fillOrEnterAdminEditor, [state.article]);
    }

    if (fillResult?.needLogin) {
      throw new Error("Admin auto-login did not complete. Check the saved credentials or captcha/login state.");
    }

    if (fillResult?.clickedAddLink) {
      await waitForTabComplete(adminTab.id);
      fillResult = await execute(adminTab.id, fillOrEnterAdminEditor, [state.article]);
    }

    if (!fillResult?.filled) {
      throw new Error(fillResult?.message || "Could not find title/body fields.");
    }

    updateStatus(`Filled title and body via ${fillResult.editor}. Publishing now.`);
    const publishResult = await execute(adminTab.id, clickAdminPublishButton);
    if (!publishResult?.clicked) {
      throw new Error(publishResult?.message || "Could not find the Add button.");
    }

    updateStatus(`Clicked ${publishResult.label || "Add"}, waiting for publish result`);
    await waitForPublishResult(adminTab.id);

    updateStatus("Searching public site for published article");
    const linkResult = await findPublishedArticleOnPublicSite(state.article.title);
    if (!linkResult?.ok) {
      throw new Error(linkResult?.error || "Published article link was not found.");
    }
    const replyMessage = EduGovCore.buildReplyMessage(
      state.article.title,
      linkResult.publishedUrl,
      state.source?.siteName || "\u4e2d\u534e\u6559\u80b2\u7f51"
    );
    const copyResult = await execute(adminTab.id, copyTextToClipboard, [replyMessage]);
    state.result = {
      replyMessage,
      publishedUrl: linkResult.publishedUrl,
      title: state.article.title,
      source: linkResult.source,
      clipboardFailed: !copyResult?.ok,
      clipboardError: copyResult?.error || ""
    };

    state.running = false;
    updateStatus(copyResult?.ok ? "Done: public article link copied" : "Done: public article link found; clipboard copy failed");
    return { ok: true, state: snapshot() };
  } catch (error) {
    state.error = error.message || String(error);
    state.running = false;
    updateStatus("Stopped");
    return { ok: false, error: state.error };
  }
}

async function extractArticleFollowingNestedLinks(tabId) {
  const hops = [];

  for (let index = 0; index < MAX_SOURCE_HOPS; index += 1) {
    const tab = await chrome.tabs.get(tabId);
    const article = await execute(tabId, extractArticleFromSourcePage, [MIN_ARTICLE_TEXT_LENGTH]);
    hops.push(tab.url);

    if (article?.contentHtml) {
      return {
        ...article,
        finalUrl: tab.url,
        hops
      };
    }

    if (!article?.nestedUrl) {
      throw new Error(article?.message || "No article body or nested article link found.");
    }

    updateStatus(`Following nested source link ${index + 1}`);
    await chrome.tabs.update(tabId, { url: article.nestedUrl, active: false });
    await waitForTabComplete(tabId);
  }

  throw new Error("Too many nested source links.");
}

function resetState() {
  state.running = false;
  state.status = "Idle";
  state.error = "";
  state.source = null;
  state.article = null;
  state.result = null;
  state.currentTabId = null;
}

function updateStatus(status) {
  state.status = status;
  const nextSnapshot = snapshot();
  chrome.storage.local.set({ [STORAGE_KEY]: nextSnapshot }).catch(() => {});
  updateBadge(nextSnapshot);
}

function updateBadge(nextSnapshot) {
  const text = nextSnapshot.error ? "ERR" : nextSnapshot.running ? "RUN" : nextSnapshot.result?.replyMessage ? "DONE" : "";
  const color = nextSnapshot.error ? "#b3261e" : nextSnapshot.running ? "#275d8c" : "#188038";
  chrome.action?.setBadgeText?.({ text }).catch(() => {});
  chrome.action?.setBadgeBackgroundColor?.({ color }).catch(() => {});
}

async function findPublishedArticleOnPublicSite(title) {
  const startedAt = Date.now();
  const cleanTarget = normalizeText(title);
  const searchUrl = `${PUBLIC_HOME_URL}?s=${encodeURIComponent(title)}`;

  while (Date.now() - startedAt < PUBLIC_SEARCH_TIMEOUT_MS) {
    const attempts = [
      { url: searchUrl, source: "public-search" },
      { url: PUBLIC_HOME_URL, source: "public-home" }
    ];

    for (const attempt of attempts) {
      const html = await fetchText(attempt.url).catch(() => "");
      const matched = findExactTitleLinkInHtml(html, cleanTarget);
      if (matched?.publishedUrl) {
        return { ok: true, publishedUrl: matched.publishedUrl, source: attempt.source };
      }
    }

    await sleep(2500);
  }

  return { ok: false, error: "Public site search did not find the newly published title." };
}

async function fetchText(url) {
  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status}`);
  }
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

function stripTags(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "");
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeText(text) {
  return decodeHtml(text)
    .replace(/\s+/g, " ")
    .trim();
}

function snapshot() {
  return {
    running: state.running,
    status: state.status,
    error: state.error,
    source: state.source,
    article: state.article,
    result: state.result,
    currentTabId: state.currentTabId
  };
}

async function openAndWait(url, active) {
  const tab = await chrome.tabs.create({ url, active });
  await waitForTabComplete(tab.id);
  return chrome.tabs.get(tab.id);
}

async function waitForTabComplete(tabId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < STEP_TIMEOUT_MS) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return tab;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("Page load timed out.");
}

async function execute(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args
  });
  return result?.result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function copyResultToActivePage() {
  const title = state.article?.title || state.source?.title || "";
  if (!title) {
    return { ok: false, error: "No article title is available for public-site search." };
  }

  const linkResult = await findPublishedArticleOnPublicSite(title);
  if (!linkResult?.ok) {
    return { ok: false, error: linkResult?.error || "Published article link was not found." };
  }

  let tabId = state.currentTabId;
  if (!(await tabExists(tabId))) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = activeTab?.id;
  }
  if (!tabId) return { ok: false, error: "No active tab." };

  const replyMessage = EduGovCore.buildReplyMessage(
    title,
    linkResult.publishedUrl,
    state.source?.siteName || "\u4e2d\u534e\u6559\u80b2\u7f51"
  );
  const copyResult = await execute(tabId, copyTextToClipboard, [replyMessage]);
  state.result = {
    replyMessage,
    publishedUrl: linkResult.publishedUrl,
    title,
    source: linkResult.source,
    clipboardFailed: !copyResult?.ok,
    clipboardError: copyResult?.error || ""
  };
  updateStatus(copyResult?.ok ? "Reply message copied from public search" : "Public link found; clipboard copy failed");
  return { ok: true, state: snapshot() };
}

async function collectPublishedLinkFromTab(tabId) {
  await waitForTabComplete(tabId);
  const linkTarget = await execute(tabId, findPublishedArticleUrl);
  const publishedUrl = linkTarget?.publishedUrl || linkTarget?.href || "";
  if (!publishedUrl) {
    return { ok: false, error: "Browse/published article link was not found on this page." };
  }

  const title = state.article?.title || state.source?.title || linkTarget?.title || "";
  const siteName = state.source?.siteName || "\u4e2d\u534e\u6559\u80b2\u7f51";
  const replyMessage = EduGovCore.buildReplyMessage(title, publishedUrl, siteName);
  const clipboardResult = await execute(tabId, copyTextToClipboard, [replyMessage]);
  const result = {
    replyMessage,
    publishedUrl,
    title,
    clipboardFailed: !clipboardResult?.ok,
    clipboardError: clipboardResult?.error || ""
  };

  if (result.replyMessage) {
    state.result = result;
    updateStatus(result.clipboardFailed ? "Published link found; clipboard copy failed" : "Reply message copied");
    return { ok: true, state: snapshot() };
  }
  return { ok: false, error: "Could not build reply message." };
}

async function tabExists(tabId) {
  if (!tabId) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch (_error) {
    return false;
  }
}

function copyTextToClipboard(text) {
  return navigator.clipboard.writeText(text)
    .then(() => ({ ok: true }))
    .catch((error) => {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        textarea.style.top = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const ok = document.execCommand("copy");
        textarea.remove();
        return { ok, error: ok ? "" : error?.message || String(error) };
      } catch (fallbackError) {
        return { ok: false, error: fallbackError?.message || error?.message || String(error) };
      }
    });
}

async function waitForPublishResult(tabId) {
  const startedAt = Date.now();
  await sleep(1200);

  while (Date.now() - startedAt < STEP_TIMEOUT_MS) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      const result = await execute(tabId, detectPublishResultPage).catch(() => null);
      if (result?.ready) return tab;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error("Publish result timed out.");
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
  return {
    ready: hasBrowse || isPublishedArticle || hasSuccessText || (!hasFormEditor && text.length > 0),
    hasBrowse,
    isPublishedArticle,
    hasSuccessText
  };
}

function findPublishedArticleUrl() {
  if (/\/edu\/\d+\.html(?:$|[?#])/i.test(location.href)) {
    return { publishedUrl: location.href, title: document.querySelector("h1")?.textContent || document.title || "" };
  }

  function normalizeUrl(rawUrl) {
    const value = String(rawUrl || "")
      .replace(/\\\//g, "/")
      .replace(/&amp;/g, "&")
      .replace(/^[\s'"(]+|[\s'")，。；;]+$/g, "");
    if (!value) return "";
    try {
      return new URL(value, location.href).href;
    } catch (_error) {
      return "";
    }
  }

  function extractUrlFromText(text) {
    const raw = String(text || "");
    const exact = raw.match(/https?:\\?\/\\?\/[^'")\]\s<>]+|\/edu\/\d+\.html(?:[?#][^'")\]\s<>]*)?/i);
    return exact ? normalizeUrl(exact[0]) : "";
  }

  function isPublishedUrl(url) {
    return /\/edu\/\d+\.html(?:$|[?#])/i.test(url);
  }

  const candidates = Array.from(document.querySelectorAll("a, button, input[type='button'], input[type='submit']"));
  const browseNode = candidates.find((node) => {
    const text = (node.innerText || node.value || node.title || "").trim();
    return text === "\u6d4f\u89c8" || text.includes("\u6d4f\u89c8");
  });

  if (browseNode) {
    const href = normalizeUrl(browseNode.href || browseNode.getAttribute?.("href"));
    if (isPublishedUrl(href)) {
      return { publishedUrl: href };
    }

    const inlineUrl = extractUrlFromText([
      browseNode.getAttribute?.("onclick"),
      browseNode.getAttribute?.("data-url"),
      browseNode.getAttribute?.("url"),
      browseNode.outerHTML
    ].filter(Boolean).join(" "));
    if (isPublishedUrl(inlineUrl)) {
      return { publishedUrl: inlineUrl };
    }
  }

  const publishedLink = Array.from(document.querySelectorAll("a[href]"))
    .map((node) => normalizeUrl(node.href || node.getAttribute("href") || ""))
    .find(isPublishedUrl);
  if (publishedLink) {
    return { publishedUrl: publishedLink };
  }

  const pageUrl = extractUrlFromText(document.documentElement.innerHTML);
  return isPublishedUrl(pageUrl) ? { publishedUrl: pageUrl } : { current: false };
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

    const selectors = [
      "#articleContent",
      "#copy_area",
      "article",
      ".TRS_Editor",
      ".rich_media_content",
      ".article-content",
      ".article_content",
      ".content",
      ".main-content",
      ".detail",
      "#content",
      "#article",
      "#main"
    ];
    const candidates = selectors
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .filter((node, index, list) => list.indexOf(node) === index);

    if (!candidates.length) return null;
    return candidates
      .map((node) => ({ node, score: scoreContentNode(node) }))
      .sort((a, b) => b.score - a.score)[0]?.node || null;
  }

  function findNestedArticleLink() {
    function normalizeUrl(rawUrl) {
      const cleaned = String(rawUrl || "")
        .replace(/\\\//g, "/")
        .replace(/&amp;/g, "&")
        .replace(/[\\'")\]}>,，。；;]+$/g, "");
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
      if (/原文|链接|点击|查看|详情|阅读|稿件|文章/.test(haystack)) score += 40;
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
        return { node, url, text };
      })
      .filter(Boolean);

    const html = document.documentElement.innerHTML;
    const scriptText = Array.from(document.scripts).map((script) => script.textContent || "").join("\n");
    const rawUrls = `${html}\n${scriptText}`.match(/https?:\\?\/\\?\/[^'"<>\s]+/ig) || [];
    const scriptUrls = rawUrls
      .map((url) => ({ url: normalizeUrl(url), text: "" }))
      .filter((item, index, list) => item.url && isUsableNestedUrl(item.url) && list.findIndex((other) => other.url === item.url) === index);

    const pageText = cleanText(document.body);
    const articleLike = anchors.concat(scriptUrls)
      .map((item) => ({ ...item, score: nestedUrlScore(item) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    if (articleLike.length === 1) return articleLike[0].url;
    if (anchors.length === 1 && pageText.length < 500) return anchors[0].url;
    return articleLike[0]?.url || "";
  }

  function contentMetrics(node) {
    if (!node) {
      return { textLength: 0, paragraphs: 0, listItems: 0, divBlocks: 0, images: 0 };
    }
    const divBlocks = Array.from(node.querySelectorAll("div"))
      .filter((item) => cleanText(item).length >= 20 && item.querySelectorAll("div, p, li").length <= 2)
      .length;
    return {
      textLength: cleanText(node).length,
      paragraphs: node.querySelectorAll("p").length,
      listItems: node.querySelectorAll("li").length,
      divBlocks,
      images: node.querySelectorAll("img").length
    };
  }

  const titleNode =
    document.querySelector("#mytitle") ||
    document.querySelector("#articleTitle") ||
    document.querySelector("#title") ||
    document.querySelector("h1") ||
    document.querySelector(".title") ||
    document.querySelector("[class*='title']");
  const contentNode = findContentNode();
  const nestedUrl = findNestedArticleLink();
  const metrics = contentMetrics(contentNode);
  const contentTextLength = metrics.textLength;
  const hasArticleBlocks = metrics.paragraphs >= 2 || metrics.listItems >= 2 || metrics.divBlocks >= 3 || metrics.images >= 1;
  const hasEmptyPreviewBody = Boolean(document.querySelector("#copy_area")) && cleanText(document.querySelector("#copy_area")).length < minTextLength;
  const hasRealBody = Boolean(contentNode) && contentTextLength >= minTextLength && hasArticleBlocks && !hasEmptyPreviewBody;

  if (!hasRealBody) {
    return {
      title: cleanText(titleNode) || document.title,
      contentHtml: "",
      contentTextLength,
      nestedUrl,
      message: "Source page does not contain enough body text."
    };
  }

  return {
    title: cleanText(titleNode) || document.title,
    contentHtml: absoluteHtml(contentNode),
    contentTextLength,
    nestedUrl: ""
  };
}

async function fillOrEnterAdminEditor(article) {
  if (/login\.php/i.test(location.href) || document.querySelector('input[type="password"]')) {
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
    return {
      filled: false,
      message: !titleInput ? "Title input not found." : contentResult.message
    };
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
    const scored = inputs
      .map((node) => {
        const haystack = [node.name, node.id, node.placeholder, node.getAttribute("aria-label")]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        let score = 0;
        if (/title|bt|subject|\u6807\u9898/.test(haystack)) score += 10;
        if (node.tagName === "TEXTAREA") score -= 3;
        if (node.offsetParent !== null) score += 2;
        return { node, score };
      })
      .sort((a, b) => b.score - a.score);
    return scored[0]?.score > 0 ? { kind: "title", node: scored[0].node } : null;
  }

  async function setEditorContent(html) {
    const editors = [];

    const ueCount = await setUEditors(html);
    if (ueCount) editors.push(`ueditor:${ueCount}`);

    const tinyCount = setTinyMceEditors(html);
    if (tinyCount) editors.push(`tinymce:${tinyCount}`);

    const ckCount = setCkEditors(html);
    if (ckCount) editors.push(`ckeditor:${ckCount}`);

    const kindCount = setKindEditors(html);
    if (kindCount) editors.push(`kindeditor:${kindCount}`);

    const iframeCount = setEditorIframes(html);
    if (iframeCount) editors.push(`iframe:${iframeCount}`);

    const editableCount = setContentEditables(html);
    if (editableCount) editors.push(`contenteditable:${editableCount}`);

    const textareaCount = setContentTextareas(html);
    if (textareaCount) editors.push(`textarea:${textareaCount}`);

    if (!editors.length) {
      return { ok: false, message: "Body editor not found." };
    }
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
      } catch (_error) {
        continue;
      }
    }
    return count;
  }

  function setTinyMceEditors(html) {
    const editors = window.tinymce?.editors || [];
    let count = 0;
    editors.forEach((editor) => {
      if (editor?.setContent) {
        editor.setContent(html);
        editor.save?.();
        count += 1;
      }
    });
    return count;
  }

  function setCkEditors(html) {
    if (!window.CKEDITOR?.instances) return 0;
    let count = 0;
    Object.values(window.CKEDITOR.instances).forEach((editor) => {
      if (editor?.setData) {
        editor.setData(html);
        editor.updateElement?.();
        count += 1;
      }
    });
    return count;
  }

  function setKindEditors(html) {
    const instances = window.KindEditor?.instances || [];
    let count = 0;
    instances.forEach((editor) => {
      if (editor?.html) {
        editor.html(html);
        editor.sync?.();
        count += 1;
      }
    });
    return count;
  }

  function setEditorIframes(html) {
    const frames = Array.from(document.querySelectorAll("iframe"));
    let count = 0;
    frames.forEach((frame) => {
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
      } catch (_error) {
        return;
      }
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
      const haystack = [node.name, node.id, node.placeholder, node.getAttribute("aria-label")]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
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

function autoLoginAdminPage(credentials) {
  const usernameInput =
    document.querySelector("#uuu_username") ||
    document.querySelector("input[name='uuu_username']") ||
    document.querySelector("input[type='text']");
  const passwordInput =
    document.querySelector("#uuu_password") ||
    document.querySelector("input[name='uuu_password']") ||
    document.querySelector("input[type='password']");

  if (!usernameInput || !passwordInput) {
    return { submitted: false, message: "Login form inputs not found." };
  }

  setNativeValue(usernameInput, credentials.username);
  setNativeValue(passwordInput, credentials.password);

  const submit =
    document.querySelector("input[type='submit']") ||
    Array.from(document.querySelectorAll("button, input[type='button'], a")).find((node) => {
      const text = (node.innerText || node.value || node.title || "").trim();
      return text === "\u767b\u5f55" || text.includes("\u767b\u5f55");
    });

  if (submit) {
    submit.click();
    return { submitted: true, method: "button" };
  }

  const form = usernameInput.form || passwordInput.form || document.forms[0];
  if (form) {
    form.requestSubmit?.();
    if (!form.requestSubmit) form.submit();
    return { submitted: true, method: "form" };
  }

  return { submitted: false, message: "Login submit control not found." };

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
  const scored = candidates
    .map((node) => {
      const label = (node.innerText || node.value || node.title || node.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      const href = node.getAttribute("href") || "";
      let score = 0;
      if (label === "\u589e\u52a0") score += 100;
      if (label.includes("\u589e\u52a0")) score += 60;
      if (/\u63d0\u4ea4|\u4fdd\u5b58|\u53d1\u5e03|\u786e\u5b9a/.test(label)) score += 30;
      if (label.includes("\u6dfb\u52a0")) score -= 100;
      if (label.includes("\u6d4f\u89c8")) score -= 100;
      if (node.type === "submit") score += 20;
      if (node.offsetParent !== null) score += 10;
      if (/javascript|submit|save|add/i.test(href)) score += 5;
      return { node, label, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

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

    try {
      (window.tinymce?.editors || []).forEach((editor) => editor?.save?.());
    } catch (_error) {}

    try {
      Object.values(window.CKEDITOR?.instances || {}).forEach((editor) => editor?.updateElement?.());
    } catch (_error) {}

    try {
      (window.KindEditor?.instances || []).forEach((editor) => editor?.sync?.());
    } catch (_error) {}

    document.querySelectorAll("textarea, input").forEach((node) => {
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
}
