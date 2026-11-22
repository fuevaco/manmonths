// 外掛（Orca 用戶端）版本：寫入部署收據的 clientVersion 與安裝回報的 clientVersion 都取自 manifest。
import { readFileSync } from 'node:fs';

export const pluginVersion = () => JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8')).version;
