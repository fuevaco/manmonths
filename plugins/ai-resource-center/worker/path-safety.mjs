// 套件內相對路徑的共用安全判斷：manifest、setup 與執行環境都用同一個，避免各處規則漂移。

/** 絕對路徑（開頭分隔符或磁碟機代號）或含 `..` 區段即為不安全。 */
export const isUnsafeRelativePath = (p) => /^[\\/]|^[a-z]:/i.test(p) || p.replaceAll('\\', '/').split('/').includes('..');
