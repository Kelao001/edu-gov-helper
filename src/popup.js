const messageInput = document.querySelector("#message");
const resultOutput = document.querySelector("#result");
const statusText = document.querySelector("#statusText");
const errorText = document.querySelector("#errorText");
const startButton = document.querySelector("#start");
const copyButton = document.querySelector("#copy");

startButton.addEventListener("click", async () => {
  setBusy(true);
  errorText.textContent = "";
  resultOutput.value = "";

  try {
    const parsed = EduGovCore.parseQQMessage(messageInput.value);
    statusText.textContent = `Starting: ${parsed.title || parsed.sourceUrl}`;
    const response = await chrome.runtime.sendMessage({
      type: "START_PUBLISH",
      payload: { message: messageInput.value }
    });
    renderResponse(response);
  } catch (error) {
    errorText.textContent = error.message || String(error);
  } finally {
    setBusy(false);
    refreshState();
  }
});

copyButton.addEventListener("click", async () => {
  setCopyBusy(true);
  errorText.textContent = "";

  try {
    const response = await chrome.runtime.sendMessage({ type: "COPY_RESULT" });
    renderResponse(response);
  } catch (error) {
    errorText.textContent = error.message || String(error);
  } finally {
    setCopyBusy(false);
    refreshState();
  }
});

refreshState();
setInterval(refreshState, 1200);

async function refreshState() {
  const currentState = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  renderState(currentState);
}

function renderResponse(response) {
  if (!response?.ok && response?.error) {
    errorText.textContent = response.error;
  }
  if (response?.state) {
    renderState(response.state);
  }
}

function renderState(currentState) {
  statusText.textContent = currentState?.status || "Idle";
  errorText.textContent = currentState?.error || "";
  setBusy(Boolean(currentState?.running));

  if (currentState?.result?.replyMessage) {
    resultOutput.value = currentState.result.replyMessage;
    return;
  }

  if (currentState?.article?.title && currentState?.source?.siteName) {
    resultOutput.placeholder = `${currentState.article.title}\n发布链接\n${currentState.source.siteName}`;
  }
}

function setBusy(busy) {
  startButton.disabled = busy;
  startButton.textContent = busy ? "处理中" : "开始转载";
}

function setCopyBusy(busy) {
  copyButton.disabled = busy;
  copyButton.textContent = busy ? "抓取中" : "抓取发布链接";
}
