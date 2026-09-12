import { randomBytes } from "node:crypto";
import {
  Controller,
  Get,
  Headers,
  HttpException,
  Param,
  Post,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { NewsroomPreviewService } from "./newsroom-preview.service";

const COMMON_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "X-Content-Type-Options": "nosniff",
};

@Controller("preview")
export class NewsroomPreviewController {
  constructor(private readonly preview: NewsroomPreviewService) {}

  @Get()
  shell(@Res() response: Response): void {
    const nonce = randomBytes(18).toString("base64url");
    setHeaders(response, {
      ...COMMON_HEADERS,
      "X-Frame-Options": "DENY",
      "Permissions-Policy":
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`,
      "Content-Type": "text/html; charset=utf-8",
    });
    response.send(shell(nonce));
  }

  @Post("render")
  async render(
    @Headers("authorization") authorization: string | string[] | undefined,
    @Res() response: Response,
  ): Promise<void> {
    setHeaders(response, COMMON_HEADERS);
    try {
      response.json(await this.preview.render(bearer(authorization)));
    } catch {
      throw unavailable();
    }
  }

  @Get("media/:mediaId")
  async media(
    @Headers("authorization") authorization: string | string[] | undefined,
    @Param("mediaId") mediaId: string,
    @Res() response: Response,
  ): Promise<void> {
    setHeaders(response, {
      ...COMMON_HEADERS,
      "Content-Security-Policy": "default-src 'none'",
    });
    try {
      const result = await this.preview.media(bearer(authorization), mediaId);
      response.setHeader("Content-Type", result.mimeType);
      response.setHeader("Content-Length", String(result.bytes.length));
      response.send(result.bytes);
    } catch {
      throw unavailable();
    }
  }
}

function bearer(value: string | string[] | undefined): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !value.startsWith("Bearer ") ||
    value.slice(7).length === 0 ||
    value.slice(7).includes(" ")
  )
    throw unavailable();
  return value.slice(7);
}

function unavailable(): HttpException {
  return new HttpException("Preview unavailable.", 404);
}

function setHeaders(response: Response, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers))
    response.setHeader(name, value);
}

function shell(nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Story preview</title><style nonce="${nonce}">body{font-family:system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem}#body{white-space:pre-wrap}.media{max-width:100%;display:block;margin:1rem 0}</style></head><body><main><h1 id="headline">Loading preview…</h1><p id="byline"></p><div id="body"></div><ul id="categories"></ul><div id="media"></div><p id="error" role="alert"></p></main><script nonce="${nonce}">(()=>{const token=new URLSearchParams(location.hash.slice(1)).get("token");history.replaceState(null,"",location.pathname+location.search);if(!token){document.getElementById("headline").textContent="Preview unavailable.";return}const h={Authorization:"Bearer "+token};fetch("/preview/render",{method:"POST",headers:h,credentials:"omit",cache:"no-store",referrerPolicy:"no-referrer"}).then(r=>{if(!r.ok)throw 0;return r.json()}).then(async d=>{document.getElementById("headline").textContent=d.headline;document.getElementById("byline").textContent=d.editorialByline;document.getElementById("body").textContent=d.body;for(const c of d.categories){const li=document.createElement("li");li.textContent=c.name;document.getElementById("categories").appendChild(li)}for(const m of d.media){const r=await fetch("/preview/media/"+encodeURIComponent(m.id),{headers:h,credentials:"omit",cache:"no-store",referrerPolicy:"no-referrer"});if(!r.ok)throw 0;const img=document.createElement("img");img.className="media";img.alt="Story media";img.src=URL.createObjectURL(await r.blob());document.getElementById("media").appendChild(img)}}).catch(()=>{document.getElementById("error").textContent="Preview unavailable."})})();</script></body></html>`;
}
