// WebWin server: serves the desktop and a /proxy endpoint that fetches pages
// server-side and strips the headers that stop sites loading in a frame.
// Run: node server.js   (Node 18+, no dependencies)
// Optional: ACCESS_KEY=secret PORT=3000 node server.js
const http = require("http"), fs = require("fs"), path = require("path");
const dns = require("dns").promises, net = require("net");
const { Readable } = require("stream");
const PORT = process.env.PORT || 3000, KEY = process.env.ACCESS_KEY || "";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Refuse private/internal addresses so the proxy can't be used to reach your network.
function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("::ffff:");
}

async function safeFetch(target, hops = 0) {
  const url = new URL(target);
  if (!/^https?:$/.test(url.protocol)) throw new Error("only http(s) addresses are allowed");
  const addrs = await dns.lookup(url.hostname, { all: true });
  if (addrs.some(a => isPrivate(a.address))) throw new Error("that address is blocked");
  const r = await fetch(url, { redirect: "manual", headers: { "user-agent": UA, accept: "*/*", "accept-language": "en-US,en;q=0.9" } });
  const loc = r.headers.get("location");
  if ([301, 302, 303, 307, 308].includes(r.status) && loc) {
    if (hops >= 5) throw new Error("too many redirects");
    return safeFetch(new URL(loc, url).href, hops + 1);
  }
  return { r, url };
}

// Runs inside proxied pages: keeps link clicks and GET forms going through the proxy.
const CLIENT = `(function(){var P="/proxy?url=";function go(h){location.href=P+encodeURIComponent(h)}
document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a[href]");if(!a||e.defaultPrevented)return;var h=a.href;if(!/^https?:/i.test(h))return;e.preventDefault();go(h)},true);
document.addEventListener("submit",function(e){var f=e.target;if((f.method||"get").toLowerCase()!=="get")return;e.preventDefault();var u=new URL(f.getAttribute("action")||"",document.baseURI);new FormData(f).forEach(function(v,k){if(typeof v==="string")u.searchParams.set(k,v)});go(u.href)},true);})();`;

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (KEY) {
    const ck = (req.headers.cookie || "").split(/;\s*/).find(c => c.startsWith("wwkey="));
    if (u.searchParams.get("key") === KEY) res.setHeader("set-cookie", "wwkey=" + encodeURIComponent(KEY) + "; HttpOnly; SameSite=Strict; Path=/");
    else if (!ck || ck.slice(6) !== encodeURIComponent(KEY)) { res.writeHead(401); return res.end("Open the site once with ?key=YOUR_ACCESS_KEY"); }
  }
  if (u.pathname === "/proxy") {
    try {
      const { r, url } = await safeFetch(u.searchParams.get("url") || "");
      const ct = r.headers.get("content-type") || "application/octet-stream";
      const h = { "content-type": ct, "cache-control": "no-store" };
      const cd = r.headers.get("content-disposition"); if (cd) h["content-disposition"] = cd;
      if (/text\/html/i.test(ct)) {
        let html = await r.text();
        const inject = '<base href="' + url.href.replace(/"/g, "&quot;") + '"><script>' + CLIENT + "</script>";
        html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + inject) : inject + html;
        res.writeHead(200, h); return res.end(html);
      }
      res.writeHead(r.status, h);
      if (!r.body) return res.end();
      Readable.fromWeb(r.body).on("error", () => res.destroy()).pipe(res);
    } catch (e) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("Could not load that page: " + e.message);
    }
    return;
  }
  if (u.pathname === "/" || u.pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(__dirname, "webwin-selfhosted.html")));
  }
  res.writeHead(404); res.end("Not found");
}).listen(PORT, () => console.log("WebWin running at http://localhost:" + PORT));
