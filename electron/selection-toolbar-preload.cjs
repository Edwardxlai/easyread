const {ipcRenderer} = require("electron");
window.addEventListener("DOMContentLoaded", () => {
  const bar = document.getElementById("selbar");
  let token;
  ipcRenderer.on("easyread:toolbar-paint", (_event, model) => {
    token = model.token;
    document.documentElement.dataset.theme = model.theme;
    bar.innerHTML = model.html;
  });
  bar.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (event.isTrusted && button) ipcRenderer.send("easyread:toolbar-pick", token, [...bar.querySelectorAll("button")].indexOf(button));
  });
});
