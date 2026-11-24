// 對話輸入框隨內容長高（Shift+Enter 換行時），最高 140px，超過改為捲動；送出後回到一行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startPanel } from './panel-harness.mjs';

test('輸入框隨內容長高到上限，超過後捲動，清空後恢復', async () => {
  const panel = await startPanel(async () => ({}));
  const input = panel.get('ai-chat-question');
  input.value = '第一行\n第二行'; input.scrollHeight = 60;
  await input.fire('input');
  assert.equal(input.style.height, '60px');
  assert.equal(input.style.overflowY, 'hidden');
  input.value = '很多行'; input.scrollHeight = 400;
  await input.fire('input');
  assert.equal(input.style.height, '140px', '最高 140px');
  assert.equal(input.style.overflowY, 'auto', '超過上限改為捲動');
  input.value = ''; input.scrollHeight = 36;
  await input.fire('input');
  assert.equal(input.style.height, '36px');
});
