(function () {
  const source = `(() => {
    window.__edugovLastDialog = "";
    window.alert = (message) => {
      window.__edugovLastDialog = String(message || "");
    };
    window.confirm = (message) => {
      window.__edugovLastDialog = String(message || "");
      return true;
    };
    window.prompt = (message, defaultValue) => {
      window.__edugovLastDialog = String(message || "");
      return defaultValue || "";
    };
  })();`;

  const script = document.createElement("script");
  script.textContent = source;
  (document.documentElement || document.head || document).appendChild(script);
  script.remove();
})();
