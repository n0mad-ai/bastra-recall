// Paste this entire file into Web Inspector on the actual hosted HTTPS page.
// Only synthetic loopback fixtures are contacted. No app token is read.
(async () => {
  if (location.protocol !== "https:" || !window.isSecureContext) {
    throw new Error("Use the actual hosted HTTPS page; local files/dev pages are not Safari gate evidence.");
  }
  const rows = [];
  for (const [name, port, method, bearer, expected] of [
    ["allowed GET + dummy bearer", 16723, "GET", "bastra-browser-probe-dummy-not-a-secret", 200],
    ["allowed POST + dummy bearer", 16723, "POST", "bastra-browser-probe-dummy-not-a-secret", 200],
    ["allowed POST without bearer", 16723, "POST", null, 401],
    ["allowed POST wrong bearer", 16723, "POST", "wrong-dummy", 401],
    ["denied origin + dummy bearer", 16724, "POST", "bastra-browser-probe-dummy-not-a-secret", "browser rejection"],
  ]) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/probe`, {
        method, mode: "cors", credentials: "omit", cache: "no-store", redirect: "error",
        headers: { ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
        ...(method === "POST" ? { body: '{"synthetic":true}' } : {}),
        signal: ctrl.signal,
      });
      const body = await response.json();
      rows.push({ name, expected, actual: response.status,
        pass: response.status === expected && body.synthetic === true,
        detail: body.synthetic === true ? "synthetic response" : "UNEXPECTED SERVER" });
    } catch (error) {
      rows.push({ name, expected, actual: "browser rejection", pass: false,
        detail: String(error) + (port === 16724 ? " — confirm denied OPTIONS in fixture log before calling this a pass" : "") });
    } finally { clearTimeout(timer); }
  }
  const report = { timestamp: new Date().toISOString(), pageOrigin: location.origin,
    secureContext: window.isSecureContext, userAgent: navigator.userAgent, rows };
  console.table(rows);
  console.log("Synthetic browser bridge report (no app tokens/data):", JSON.stringify(report, null, 2));
  return report;
})();
