import concurrent.futures
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

sys.stdout.reconfigure(encoding='utf-8')

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZH_TW_PATH = os.path.join(BASE_DIR, "plugins", "zh-tw", "locales", "zh-TW.json")

CJK_RE = re.compile(r'[\u4e00-\u9fff]')
PLACEHOLDER_RE = re.compile(r'\{\{[^}]+\}\}')
CODE_OR_TAG_RE = re.compile(r'`[^`]+`|<[^>]+>')
WORD_RE = re.compile(r'[A-Za-z]{2,}')

SKIP_EXACT = {
    'OK', 'Ok', 'Git', 'GitHub', 'GitLab', 'Linear', 'Jira', 'Orca', 'Claude',
    'Codex', 'Gemini', 'OpenAI', 'Anthropic', 'Docker', 'WSL', 'SSH', 'HTTP',
    'HTTPS', 'URL', 'URI', 'API', 'CLI', 'SDK', 'MCP', 'JSON', 'YAML', 'TOML',
    'CSV', 'TSV', 'HTML', 'CSS', 'SVG', 'PNG', 'PDF', 'UTF-8', 'ID', 'UUID',
    'PID', 'TTY', 'PTY', 'CPU', 'GPU', 'RAM', 'UI', 'UX', 'IDE', 'OS', 'macOS',
    'Windows', 'Linux', 'Ubuntu', 'PowerShell', 'Bash', 'Zsh', 'Fish', 'Cmd',
    'Ctrl', 'Alt', 'Shift', 'Tab', 'Esc', 'Enter', 'Space', 'Backspace',
    'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'N/A', 'TBD', 'WIP',
    'Bitbucket', 'Azure DevOps', 'Gitea', 'Multipass', 'VS Code', 'Cursor',
    'Warp', 'iTerm2', 'Alacritty', 'Ghostty', 'Kitty', 'WezTerm', 'tmux',
    'npm', 'pnpm', 'yarn', 'bun', 'pip', 'uv', 'cargo', 'go', 'git',
    'Markdown', 'Mermaid', 'Marp', 'LaTeX', 'KaTeX',
}

# Taiwan Traditional Chinese terminology normalization
TW_TERM_REPLACEMENTS = [
    ('項目', '專案'),
    ('網絡', '網路'),
    ('代碼', '程式碼'),
    ('文件夾', '資料夾'),
    ('默認', '預設'),
    ('保存', '儲存'),
    ('設置', '設定'),
    ('刷新', '重新整理'),
    ('搜索', '搜尋'),
    ('用戶', '使用者'),
    ('支持', '支援'),
    ('信息', '資訊'),
    ('內存', '記憶體'),
    ('進程', '處理程序'),
    ('線程', '執行緒'),
    ('鏈接', '連結'),
    ('調試', '除錯'),
    ('服務器', '伺服器'),
    ('數據', '資料'),
    ('創建', '建立'),
    ('刪除', '刪除'),
    ('當前', '目前'),
    ('通過', '透過'),
    ('激活', '啟用'),
    ('禁用', '停用'),
    ('選項卡', '分頁'),
    ('標籤頁', '分頁'),
    ('剪貼板', '剪貼簿'),
    ('回車', 'Enter'),
    ('空格', '空白鍵'),
    ('運行', '執行'),
    ('終端', '終端機'),
    ('工作區', '工作區'),
    ('代理', 'Agent'),
    ('智能體', 'Agent'),
]


def should_translate(text: str) -> bool:
    if not text or not isinstance(text, str):
        return False
    if CJK_RE.search(text):
        return False
    stripped = text.strip()
    if not stripped or stripped in SKIP_EXACT:
        return False
    # Strip placeholders and code/tags to see if any real English words remain
    cleaned = PLACEHOLDER_RE.sub(' ', stripped)
    cleaned = CODE_OR_TAG_RE.sub(' ', cleaned)
    # Skip keyboard shortcuts like "Ctrl+Shift+P", "Cmd+K"
    if re.fullmatch(r'(?:(?:Ctrl|Cmd|Alt|Shift|Opt|Option|Meta|Super|Win)\+)+[A-Za-z0-9/.\[\]\\-]+', cleaned.strip(), re.I):
        return False
    words = WORD_RE.findall(cleaned)
    if not words:
        return False
    # If all words are in SKIP_EXACT, skip
    if all(w in SKIP_EXACT or w.upper() in SKIP_EXACT for w in words):
        return False
    return True


def protect_tokens(text: str):
    tokens = []

    def repl(match):
        idx = len(tokens)
        tokens.append(match.group(0))
        return f'[[{idx}]]'

    protected = PLACEHOLDER_RE.sub(repl, text)
    protected = CODE_OR_TAG_RE.sub(repl, protected)
    return protected, tokens


def restore_tokens(text: str, tokens: list[str]) -> str:
    def repl(match):
        idx = int(match.group(1))
        if 0 <= idx < len(tokens):
            return tokens[idx]
        return match.group(0)

    # Handle possible spaces inserted around brackets by translator: [[ 0 ]] or [[0]]
    return re.sub(r'\[\[\s*(\d+)\s*\]\]', repl, text)


def normalize_tw_terms(text: str) -> str:
    for src, dst in TW_TERM_REPLACEMENTS:
        text = text.replace(src, dst)
    # Clean up extra spaces around ASCII/Agent if needed, keep clean punctuation
    return text.strip()


def google_translate(text: str, retries: int = 3) -> str:
    q = urllib.parse.quote(text)
    url = f'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-TW&dt=t&q={q}'
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                return ''.join(seg[0] for seg in data[0] if seg and seg[0])
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(0.5 * (attempt + 1))
    return text


def translate_one(key: str, text: str) -> tuple[str, str, bool]:
    protected, tokens = protect_tokens(text)
    try:
        translated = google_translate(protected)
        restored = restore_tokens(translated, tokens)
        restored = normalize_tw_terms(restored)
        # Verify all {{...}} placeholders match exactly
        orig_ph = sorted(PLACEHOLDER_RE.findall(text))
        new_ph = sorted(PLACEHOLDER_RE.findall(restored))
        if orig_ph != new_ph:
            return key, text, False
        return key, restored, True
    except Exception:
        return key, text, False


def translate_batch(items: list[tuple[str, str]]) -> list[tuple[str, str, bool]]:
    # Batch up to 15 items per HTTP request using a distinct separator
    sep = '\n[[[SEP]]]\n'
    protected_list = []
    tokens_list = []
    for _, text in items:
        p, t = protect_tokens(text)
        protected_list.append(p.replace('\n', ' '))
        tokens_list.append(t)

    joined = sep.join(protected_list)
    if len(joined) < 3500:
        try:
            translated_joined = google_translate(joined)
            parts = re.split(r'\s*\[\[\[\s*SEP\s*\]\]\]\s*', translated_joined)
            if len(parts) == len(items):
                results = []
                for (key, orig), part, tokens in zip(items, parts, tokens_list):
                    restored = restore_tokens(part, tokens)
                    restored = normalize_tw_terms(restored)
                    if sorted(PLACEHOLDER_RE.findall(orig)) == sorted(PLACEHOLDER_RE.findall(restored)):
                        results.append((key, restored, True))
                    else:
                        results.append(translate_one(key, orig))
                return results
        except Exception:
            pass

    # Fallback to individual translation
    return [translate_one(k, v) for k, v in items]


def flatten_dict(d: dict, prefix: str = '') -> dict[str, str]:
    out = {}
    for k, v in d.items():
        p = f'{prefix}.{k}' if prefix else k
        if isinstance(v, dict):
            out.update(flatten_dict(v, p))
        elif isinstance(v, str):
            out[p] = v
    return out


def set_nested(d: dict, path: str, value: str):
    parts = path.split('.')
    cur = d
    for p in parts[:-1]:
        cur = cur[p]
    cur[parts[-1]] = value


def main():
    print(f'Loading {ZH_TW_PATH}...')
    with open(ZH_TW_PATH, 'r', encoding='utf-8') as f:
        tree = json.load(f)

    flat = flatten_dict(tree)
    targets = [(k, v) for k, v in flat.items() if should_translate(v)]
    print(f'Total leaf keys: {len(flat)}')
    print(f'Keys needing auto-translation: {len(targets)}')

    if not targets:
        print('Nothing to translate!')
        return

    # Group into batches of 15
    batch_size = 15
    batches = [targets[i:i + batch_size] for i in range(0, len(targets), batch_size)]
    print(f'Translating in {len(batches)} batches (8 concurrent workers)...')

    translated_count = 0
    skipped_count = 0
    start_time = time.time()

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        for idx, batch_res in enumerate(executor.map(translate_batch, batches), 1):
            for key, new_val, ok in batch_res:
                if ok and new_val and new_val != flat[key]:
                    set_nested(tree, key, new_val)
                    translated_count += 1
                else:
                    skipped_count += 1
            if idx % 20 == 0 or idx == len(batches):
                elapsed = time.time() - start_time
                print(f'  Progress: {idx}/{len(batches)} batches ({translated_count} translated, {skipped_count} kept, {elapsed:.1f}s)')

    with open(ZH_TW_PATH, 'w', encoding='utf-8') as f:
        json.dump(tree, f, ensure_ascii=False, indent=2)
        f.write('\n')

    print(f'\nDone! Translated {translated_count} entries, kept {skipped_count} entries.')


if __name__ == '__main__':
    main()
