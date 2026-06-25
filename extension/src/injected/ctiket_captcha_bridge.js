// src/injected/ctiket_captcha_bridge.js
// Chay o MAIN world — co the thay duoc grecaptcha cua trang.
// Giao tiep voi ISOLATED world (queue_watcher.js) qua CustomEvent tren document.
//
// ISOLATED world dispatch "svp:getCaptcha"
// MAIN world lang nghe, cho grecaptcha san sang, tra ket qua qua "svp:captchaResult"

(function () {
  const SITE_KEY = "6Leg798rAAAAAOQwZrZvhwtxUCvmXkNk3bGbexv0";

  function waitForGrecaptcha(timeout) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeout;
      function check() {
        if (typeof grecaptcha !== "undefined") {
          resolve();
        } else if (Date.now() < deadline) {
          setTimeout(check, 100);
        } else {
          reject(new Error("grecaptcha not found in MAIN world after " + timeout + "ms"));
        }
      }
      check();
    });
  }

  document.addEventListener("svp:getCaptcha", () => {
    const globalTimeout = setTimeout(() => {
      document.dispatchEvent(new CustomEvent("svp:captchaResult", {
        detail: { error: "captcha global timeout 15s" }
      }));
    }, 15000);

    waitForGrecaptcha(10000)
      .then(() => new Promise((resolve, reject) => {
        clearTimeout(globalTimeout);
        const t = setTimeout(() => reject(new Error("grecaptcha.execute timeout")), 10000);
        grecaptcha.ready(() => {
          clearTimeout(t);
          grecaptcha.execute(SITE_KEY, { action: "submit" })
            .then(resolve).catch(reject);
        });
      }))
      .then(token => {
        document.dispatchEvent(new CustomEvent("svp:captchaResult", { detail: { token } }));
      })
      .catch(err => {
        clearTimeout(globalTimeout);
        document.dispatchEvent(new CustomEvent("svp:captchaResult", {
          detail: { error: err.message }
        }));
      });
  });
})();