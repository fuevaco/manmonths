/**
 * Orca Markdown Marp & Mermaid Preview Controller
 */

(() => {
  'use strict';

  // --- State ---
  let rawMarkdown = '';
  let viewMode = 'auto'; // 'auto' | 'marp' | 'doc'
  let slideMode = 'continuous'; // 'single' | 'continuous'
  let currentSlide = 1;
  let totalSlides = 1;
  let zoomLevel = 1.0;
  let currentTheme = 'dark'; // 'dark' | 'light'
  let debounceTimer = null;
  let isFullscreen = false;
  let renderSeq = 0;

  // --- Engines ---
  let marpInstance = null;
  let mdInstance = null;

  // --- Elements ---
  const marpContainer = document.getElementById('marp-container');
  const docContainer = document.getElementById('doc-container');
  const marpStyle = document.getElementById('marp-style');
  const slideCounter = document.getElementById('slide-counter');
  const prevSlideBtn = document.getElementById('btn-prev-slide');
  const nextSlideBtn = document.getElementById('btn-next-slide');
  const slideControls = document.getElementById('slide-controls');
  const modeAutoBtn = document.getElementById('btn-mode-auto');
  const modeMarpBtn = document.getElementById('btn-mode-marp');
  const modeDocBtn = document.getElementById('btn-mode-doc');
  const layoutSingleBtn = document.getElementById('btn-layout-single');
  const layoutContinuousBtn = document.getElementById('btn-layout-continuous');
  const fullscreenBtn = document.getElementById('btn-fullscreen');
  const zoomInBtn = document.getElementById('btn-zoom-in');
  const zoomOutBtn = document.getElementById('btn-zoom-out');
  const zoomResetBtn = document.getElementById('btn-zoom-reset');
  const printBtn = document.getElementById('btn-print');
  const mermaidBadge = document.getElementById('mermaid-badge');

  function getMermaidConfig(theme) {
    return {
      startOnLoad: false,
      theme: theme === 'dark' ? 'dark' : 'default',
      securityLevel: 'strict',
      fontFamily: 'var(--app-font)',
      flowchart: { useMaxWidth: true, htmlLabels: true },
      sequence: { useMaxWidth: true },
      gantt: { useMaxWidth: true }
    };
  }

  // --- Initialize Engines ---
  function initEngines() {
    if (window.Marp) {
      marpInstance = new window.Marp({
        html: true,
        markdown: {
          breaks: true
        }
      });
    }

    if (window.createMarkdownIt) {
      mdInstance = window.createMarkdownIt();
    }

    if (window.mermaid) {
      window.mermaid.initialize(getMermaidConfig(currentTheme));
    }
  }

  // --- Frontmatter & Mode Detection ---
  function hasMarpFrontmatter(text) {
    if (!text) return false;
    const trimmed = text.trim();
    if (!trimmed.startsWith('---')) return false;
    const endMatch = trimmed.indexOf('\n---', 3);
    if (endMatch === -1) return false;
    const frontmatter = trimmed.slice(3, endMatch);
    return /^\s*marp\s*:\s*true/im.test(frontmatter);
  }

  function getEffectiveMode() {
    if (viewMode === 'marp') return 'marp';
    if (viewMode === 'doc') return 'doc';
    return hasMarpFrontmatter(rawMarkdown) ? 'marp' : 'doc';
  }

  // --- Theme Management ---
  function setTheme(theme, skipRender = false) {
    currentTheme = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', currentTheme);
    document.body.className = currentTheme;

    if (window.mermaid) {
      window.mermaid.initialize(getMermaidConfig(currentTheme));
    }

    // Trigger re-render to update mermaid and marp colors
    if (!skipRender) {
      render();
    }
  }

  // --- Mermaid Diagram Renderer ---
  async function renderMermaidBlocks(container, seq) {
    if (!window.mermaid) return;

    const codeBlocks = container.querySelectorAll('code.language-mermaid');
    if (codeBlocks.length === 0) {
      if (mermaidBadge) mermaidBadge.style.display = 'none';
      return;
    }

    if (mermaidBadge) {
      mermaidBadge.textContent = `Mermaid: ${codeBlocks.length}`;
      mermaidBadge.style.display = 'inline-block';
    }

    for (let i = 0; i < codeBlocks.length; i++) {
      if (seq !== renderSeq) return;
      const block = codeBlocks[i];
      const pre = block.closest('pre');
      if (!pre || !pre.parentNode) continue;

      const code = block.textContent.trim();
      const diagramId = `mermaid-svg-${seq}-${i}`;

      const wrapper = document.createElement('div');
      wrapper.className = 'mermaid-diagram-wrapper';
      wrapper.id = `wrapper-${diagramId}`;

      try {
        const { svg } = await window.mermaid.render(diagramId, code);
        if (seq !== renderSeq) return;
        wrapper.innerHTML = svg;
      } catch (err) {
        if (seq !== renderSeq) return;
        console.warn('Mermaid render error:', err);
        const errBox = document.createElement('div');
        errBox.className = 'mermaid-error-box';
        errBox.textContent = `[Mermaid 語法解析錯誤]\n${err.message || err}\n\n原始代碼：\n${code}`;
        wrapper.appendChild(errBox);
      }

      if (pre.parentNode) {
        pre.parentNode.replaceChild(wrapper, pre);
      }
    }
  }

  // --- Main Render Function ---
  async function render() {
    const seq = ++renderSeq;
    const effectiveMode = getEffectiveMode();

    if (effectiveMode === 'marp' && marpInstance) {
      // 1. Render as Marp Presentation
      slideControls.style.display = 'inline-flex';
      docContainer.style.display = 'none';
      marpContainer.style.display = 'flex';

      try {
        const { html, css } = marpInstance.render(rawMarkdown);
        if (seq !== renderSeq) return;
        if (marpStyle) {
          marpStyle.textContent = css;
        }
        marpContainer.innerHTML = html;

        // Apply slide mode
        marpContainer.className = slideMode === 'single' ? 'mode-single' : 'mode-continuous';

        // Count slides
        const slides = marpContainer.querySelectorAll('.marpit > svg');
        totalSlides = Math.max(1, slides.length);
        if (currentSlide > totalSlides) currentSlide = totalSlides;
        if (currentSlide < 1) currentSlide = 1;

        // In single slide mode, set active slide
        if (slideMode === 'single') {
          slides.forEach((svg, idx) => {
            if (idx + 1 === currentSlide) {
              svg.classList.add('active-slide');
            } else {
              svg.classList.remove('active-slide');
            }
          });
        }

        updateSlideUI();
        await renderMermaidBlocks(marpContainer, seq);
      } catch (e) {
        if (seq !== renderSeq) return;
        console.error('Marp render error:', e);
        marpContainer.innerHTML = '';
        const errBox = document.createElement('div');
        errBox.className = 'mermaid-error-box';
        errBox.textContent = `Marp 渲染失敗: ${e.message}`;
        marpContainer.appendChild(errBox);
      }
    } else {
      // 2. Render as Standard Document
      slideControls.style.display = 'none';
      marpContainer.style.display = 'none';
      docContainer.style.display = 'block';

      if (mdInstance) {
        try {
          docContainer.innerHTML = mdInstance.render(rawMarkdown);
          await renderMermaidBlocks(docContainer, seq);
        } catch (e) {
          if (seq !== renderSeq) return;
          console.error('Markdown-it render error:', e);
          docContainer.innerHTML = '';
          const errBox = document.createElement('div');
          errBox.className = 'mermaid-error-box';
          errBox.textContent = `Markdown 渲染失敗: ${e.message}`;
          docContainer.appendChild(errBox);
        }
      }
    }

    if (seq === renderSeq) {
      applyZoom();
    }
  }

  // --- Slide Navigation ---
  function updateSlideUI() {
    if (slideCounter) {
      slideCounter.textContent = `${currentSlide} / ${totalSlides}`;
    }
    if (prevSlideBtn) prevSlideBtn.disabled = currentSlide <= 1;
    if (nextSlideBtn) nextSlideBtn.disabled = currentSlide >= totalSlides;
  }

  function goToSlide(n) {
    if (n < 1) n = 1;
    if (n > totalSlides) n = totalSlides;
    currentSlide = n;

    if (slideMode === 'single') {
      const slides = marpContainer.querySelectorAll('.marpit > svg');
      slides.forEach((svg, idx) => {
        if (idx + 1 === currentSlide) {
          svg.classList.add('active-slide');
        } else {
          svg.classList.remove('active-slide');
        }
      });
      updateSlideUI();
    } else {
      // Continuous mode: scroll into view
      const slides = marpContainer.querySelectorAll('.marpit > svg');
      if (slides[currentSlide - 1]) {
        slides[currentSlide - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      updateSlideUI();
    }
  }

  function nextSlide() {
    if (currentSlide < totalSlides) goToSlide(currentSlide + 1);
  }

  function prevSlide() {
    if (currentSlide > 1) goToSlide(currentSlide - 1);
  }

  // --- Zoom Controls ---
  function applyZoom() {
    const scale = `scale(${zoomLevel})`;
    if (marpContainer) marpContainer.style.transform = zoomLevel === 1.0 ? '' : scale;
    if (docContainer) docContainer.style.transform = zoomLevel === 1.0 ? '' : scale;
    if (zoomResetBtn) zoomResetBtn.textContent = `${Math.round(zoomLevel * 100)}%`;
  }

  function setZoom(level) {
    zoomLevel = Math.max(0.5, Math.min(2.0, level));
    applyZoom();
  }

  // --- Fullscreen Presentation ---
  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch((err) => {
        console.warn('Fullscreen request failed:', err);
      });
      isFullscreen = true;
    } else {
      document.exitFullscreen().catch(() => {});
      isFullscreen = false;
    }
  }

  // --- Debounced Document Sync ---
  function updateMarkdown(content, immediate = false) {
    rawMarkdown = content || '';
    clearTimeout(debounceTimer);
    if (immediate) {
      render();
    } else {
      debounceTimer = setTimeout(() => {
        render();
      }, 150);
    }
  }

  // --- UI Event Handlers ---
  function setupUI() {
    // Mode toggles
    modeAutoBtn.addEventListener('click', () => {
      viewMode = 'auto';
      updateModeButtons();
      render();
    });

    modeMarpBtn.addEventListener('click', () => {
      viewMode = 'marp';
      updateModeButtons();
      render();
    });

    modeDocBtn.addEventListener('click', () => {
      viewMode = 'doc';
      updateModeButtons();
      render();
    });

    function updateModeButtons() {
      modeAutoBtn.classList.toggle('active', viewMode === 'auto');
      modeMarpBtn.classList.toggle('active', viewMode === 'marp');
      modeDocBtn.classList.toggle('active', viewMode === 'doc');
    }

    // Slide navigation
    prevSlideBtn.addEventListener('click', prevSlide);
    nextSlideBtn.addEventListener('click', nextSlide);

    // Slide layout toggles
    layoutSingleBtn.addEventListener('click', () => {
      slideMode = 'single';
      layoutSingleBtn.classList.add('active');
      layoutContinuousBtn.classList.remove('active');
      render();
    });

    layoutContinuousBtn.addEventListener('click', () => {
      slideMode = 'continuous';
      layoutContinuousBtn.classList.add('active');
      layoutSingleBtn.classList.remove('active');
      render();
    });

    // Fullscreen
    fullscreenBtn.addEventListener('click', toggleFullscreen);

    // Zoom
    zoomInBtn.addEventListener('click', () => setZoom(zoomLevel + 0.1));
    zoomOutBtn.addEventListener('click', () => setZoom(zoomLevel - 0.1));
    zoomResetBtn.addEventListener('click', () => setZoom(1.0));

    // Intercept anchor and external links inside preview
    const viewport = document.getElementById('viewport');
    if (viewport) {
      viewport.addEventListener('click', (e) => {
        const anchor = e.target.closest ? e.target.closest('a[href]') : null;
        if (!anchor) return;
        const href = anchor.getAttribute('href');
        if (!href) return;
        if (href.startsWith('#')) {
          e.preventDefault();
          const targetId = decodeURIComponent(href.slice(1));
          const target = document.getElementById(targetId);
          if (target) target.scrollIntoView({ behavior: 'smooth' });
          return;
        }
        if (/^(https?:|mailto:)/i.test(href)) {
          e.preventDefault();
          if (window.orca && window.orca.shell && window.orca.shell.openExternal) {
            window.orca.shell.openExternal(href).catch((err) => {
              console.warn('openExternal failed:', err);
            });
          } else {
            window.open(href, '_blank', 'noopener,noreferrer');
          }
        }
      });
    }

    // Print
    printBtn.addEventListener('click', () => window.print());

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      const activeTag = document.activeElement ? document.activeElement.tagName : '';
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;

      if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) {
        if (getEffectiveMode() === 'marp') {
          e.preventDefault();
          nextSlide();
        }
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) {
        if (getEffectiveMode() === 'marp') {
          e.preventDefault();
          prevSlide();
        }
      } else if (e.key === 'Home') {
        if (getEffectiveMode() === 'marp') {
          e.preventDefault();
          goToSlide(1);
        }
      } else if (e.key === 'End') {
        if (getEffectiveMode() === 'marp') {
          e.preventDefault();
          goToSlide(totalSlides);
        }
      } else if (e.key === 'f' || e.key === 'F' || e.key === 'F5') {
        e.preventDefault();
        toggleFullscreen();
      }
    });
  }

  // --- Sample Demo Markdown for Standalone Test ---
  function loadDemoMarkdown() {
    const demo = `---
marp: true
theme: default
paginate: true
header: "Orca Markdown Marp & Mermaid 預覽"
footer: "支援即時 Mermaid 圖表與 Marp 投影片"
---

# 歡迎使用 Marp & Mermaid 預覽套件 🚀

這是專為 **Orca** 開發的高效能 Markdown 預覽外掛：
- 🎯 **Marp 簡報模式**：支援投影片語法、主題與分頁
- 📊 **Mermaid 圖表**：即時繪製流程圖、循序圖與架構圖
- 🌓 **主題連動**：自動匹配 Orca 深色 / 淺色介面
- 🖨️ **PDF 匯出**：一鍵預覽與列印投影片

---

<!-- _theme: gaia -->
<!-- _class: lead -->

# 架構流程示範 (Mermaid)

以下為內嵌於 Marp 簡報中的 Mermaid 流程圖：

\`\`\`mermaid
flowchart LR
    A[Markdown 原始檔案] --> B(Orca 編輯器)
    B --> C{自動偵測}
    C -->|marp: true| D[Marp 簡報模式]
    C -->|一般文件| E[文件閱讀模式]
    D --> F((即時渲染 Mermaid))
    E --> F
\`\`\`

---

# 循序圖示範 (Sequence Diagram)

\`\`\`mermaid
sequenceDiagram
    autonumber
    actor 使用者 as 開發者
    participant IDE as Orca 編輯器
    participant Plugin as Marp & Mermaid 套件

    使用者->>IDE: 編輯 Markdown 檔案
    IDE-->>Plugin: orca.document.session()
    Plugin->>Plugin: 解析 Marp 投影片與 Mermaid
    Plugin-->>使用者: 即時顯示美麗的預覽畫面
\`\`\`

---

# 統計圖表 (Pie Chart)

\`\`\`mermaid
pie title Markdown 文件使用分佈
    "專案說明 README" : 45
    "技術簡報 Marp" : 35
    "架構設計 Mermaid" : 20
\`\`\`
`;
    updateMarkdown(demo);
  }

  // --- Main Bootstrap ---
  async function init() {
    initEngines();
    setupUI();

    // Check if running inside Orca Custom Editor
    if (window.orca && window.orca.document) {
      if (window.orca.on) {
        window.orca.on('theme', (theme) => {
          if (theme && theme.colorScheme) {
            setTheme(theme.colorScheme);
          }
        });
      }

      try {
        const session = await window.orca.document.session();
        const initialTheme = document.documentElement.classList.contains('light') ? 'light' : 'dark';
        setTheme(initialTheme, true);
        updateMarkdown(session.value, true);
        session.onReplace((newValue) => {
          updateMarkdown(newValue);
        });
      } catch (err) {
        console.warn('Orca document session fallback to onDidChange:', err);
        const initialTheme = document.documentElement.classList.contains('light') ? 'light' : 'dark';
        setTheme(initialTheme, true);
        window.orca.document.onDidChange((doc) => {
          if (doc && doc.content) {
            updateMarkdown(doc.content.kind === 'text' ? doc.content.text : '', true);
          }
        });
      }
    } else {
      // Standalone mode in browser
      const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      setTheme(isDark ? 'dark' : 'light', true);
      loadDemoMarkdown();
    }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
