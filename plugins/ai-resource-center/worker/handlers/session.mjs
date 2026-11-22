// rc.session.*：市集網址、登入、登出與目前狀態。
import { str } from '../contract.mjs';

export function registerSessionHandlers(router, { session, host }) {
  /** → { marketUrl, signedIn, account?, notice?, secretsProtection?: 'os-keyring'|'unavailable' } */
  router.handle('rc.session.getState', async () => {
    // 舊 host 不支援時省略；可用時在讀取工作階段之前先查鑰匙圈。
    const protection = host?.has?.('secrets.protection') ? await host.call('secrets.protection') : null;
    return { ...await session.getState({ secretsProtection: protection?.status }), ...(protection ? { secretsProtection: protection.status } : {}) };
  });

  /** { marketUrl, username, password } → 同 getState */
  router.handle('rc.session.signIn', async (input) =>
    session.signIn({ marketUrl: str(input, 'marketUrl'), username: str(input, 'username'), password: str(input, 'password') }));

  /** → { signedIn: false, marketUrl } */
  router.handle('rc.session.signOut', async () => session.signOut());
}
