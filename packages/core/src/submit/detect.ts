/// <reference lib="dom" />
import type { Page } from 'playwright';

const CONFIRM_URL = /(\/confirmation|\/thanks|thank-you|application-submitted)/i;
const CONFIRM_TEXT = /thank you for (applying|your application|your interest)|application (has been |was )?(successfully )?(submitted|received)|we('ve| have) received your application/i;
const LOGIN_URL = /\/(login|signin|sign_in|auth)\b/i;
const LOGIN_TEXT = /sign in to (continue|apply)|log in to apply|create an account to apply/i;
const CHALLENGE_SRC = /recaptcha\/(api2|enterprise)\/bframe|hcaptcha\.com.*(challenge|hcaptcha-challenge)/;

export function detectConfirmation(url: string, text: string): boolean {
  return CONFIRM_URL.test(url) || CONFIRM_TEXT.test(text);
}

export function detectLoginWall(url: string, text: string): boolean {
  return LOGIN_URL.test(url) || LOGIN_TEXT.test(text);
}

export async function detectCaptchaChallenge(page: Page): Promise<boolean> {
  const frames = await page.locator('iframe').all();
  for (const f of frames) {
    const src = (await f.getAttribute('src')) ?? '';
    const title = (await f.getAttribute('title')) ?? '';
    if (!CHALLENGE_SRC.test(src) && !/challenge/i.test(title)) continue;
    if (!(await f.isVisible())) continue;
    const box = await f.boundingBox();
    if (box && box.width >= 100 && box.height >= 100) return true;
  }
  return false;
}
