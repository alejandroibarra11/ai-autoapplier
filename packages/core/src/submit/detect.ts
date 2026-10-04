/// <reference lib="dom" />
import type { Page } from 'playwright';

const CONFIRM_URL = /(\/confirmation|\/thanks|\/thank-you|\/application-submitted)\/?(\?|#|$)/i;
const CONFIRM_TEXT = /thank you for (applying|your application)|application (has been |was )?(successfully )?(submitted|received)|we('ve| have) received your application/gi;
const CONDITIONAL = /(?:^|\W)(?:if|once|after|until|no)\s*$/i;
const LOGIN_URL = /\/(login|signin|sign_in|auth)\b/i;
const LOGIN_TEXT = /sign in to (continue|apply)|log in to apply|create an account to apply/i;
const CHALLENGE_SRC = /recaptcha\/(api2|enterprise)\/bframe|hcaptcha\.com.*(challenge|hcaptcha-challenge)/;

export function detectConfirmation(s: { preUrl: string; url: string; text: string; formPresent: boolean }): boolean {
  if (s.url !== s.preUrl) {
    let path = s.url;
    try { const u = new URL(s.url); path = u.pathname + u.search + u.hash; } catch { /* keep raw */ }
    if (CONFIRM_URL.test(path)) return true;
  }
  if (s.formPresent) return false;
  for (const m of s.text.matchAll(CONFIRM_TEXT)) {
    const before = s.text.slice(Math.max(0, m.index - 20), m.index);
    if (!CONDITIONAL.test(before)) return true;
  }
  return false;
}

export function detectLoginWall(url: string, text: string): boolean {
  return LOGIN_URL.test(url) || LOGIN_TEXT.test(text);
}

export async function detectCaptchaChallenge(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    let frames;
    try { frames = await frame.locator('iframe').all(); } catch { continue; }
    for (const f of frames) {
      try {
        const src = (await f.getAttribute('src', { timeout: 1000 })) ?? '';
        const title = (await f.getAttribute('title', { timeout: 1000 })) ?? '';
        if (!CHALLENGE_SRC.test(src) && !/challenge/i.test(title)) continue;
        if (!(await f.isVisible())) continue;
        const box = await f.boundingBox();
        if (box && box.width >= 100 && box.height >= 100) return true;
      } catch { /* detached or inaccessible: skip */ }
    }
  }
  return false;
}
