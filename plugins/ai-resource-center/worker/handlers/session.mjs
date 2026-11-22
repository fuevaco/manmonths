// rc.session.*：市集網址、登入、登出與目前狀態。
import { str } from '../contract.mjs';

export function registerSessionHandlers(router, { session }) {
  /** → { marketUrl, signedIn, account?, notice? } */
  router.handle('rc.session.getState', async () => session.getState());

  /** { marketUrl, username, password } → 同 getState */
  router.handle('rc.session.signIn', async (input) =>
    session.signIn({ marketUrl: str(input, 'marketUrl'), username: str(input, 'username'), password: str(input, 'password') }));

  /** → { signedIn: false, marketUrl } */
  router.handle('rc.session.signOut', async () => session.signOut());
}
