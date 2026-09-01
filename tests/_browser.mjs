/**
 * 테스트용 크로미움 실행 헬퍼.
 *
 * 보통은 `npx playwright install chromium` 으로 받은 브라우저를 그대로 쓴다.
 * CI·샌드박스처럼 브라우저가 이미 다른 경로에 설치돼 있는 환경을 위해
 * PW_CHROMIUM 환경변수로 실행 파일을 지정할 수 있게 열어 둔다.
 *
 *   PW_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npm test
 */
import { chromium } from 'playwright';

export async function launchChromium(opts = {}) {
  const exe = process.env.PW_CHROMIUM;
  try {
    return await chromium.launch(exe ? { ...opts, executablePath: exe } : opts);
  } catch (err) {
    if (exe) throw err;
    throw new Error(
      `크로미움을 실행하지 못했습니다: ${err.message}\n`
      + '  → npx playwright install chromium 을 실행하거나,\n'
      + '    이미 설치돼 있다면 PW_CHROMIUM=<크로미움 실행파일 경로> 로 지정하세요.');
  }
}
