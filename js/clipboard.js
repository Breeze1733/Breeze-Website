// js/clipboard.js
const API_BASE = '/api';

const clipInput = document.getElementById('clip-input');
const pasteBtn = document.getElementById('paste-btn');
const saveBtn = document.getElementById('save-btn');
const saveStatus = document.getElementById('save-status');
const clipListUl = document.getElementById('clip-list');

// 当前正在编辑的剪切板 ID（null 表示新建模式）
let editingId = null;

// 1. 从系统剪切板粘贴内容
pasteBtn.addEventListener('click', async () => {
    try {
        const text = await navigator.clipboard.readText();
        if (text) {
            clipInput.value = text;
            saveStatus.textContent = '✅ 已从剪切板粘贴';
            saveStatus.style.color = '#00e5ff';
            setTimeout(() => { saveStatus.textContent = ''; }, 2000);
        } else {
            saveStatus.textContent = '⚠️ 剪切板为空';
            saveStatus.style.color = '#ff6b6b';
        }
    } catch (err) {
        saveStatus.textContent = '⚠️ 无法读取剪切板，请手动粘贴';
        saveStatus.style.color = '#ff6b6b';
        console.error('Clipboard read failed:', err);
    }
});

// 2. 保存/更新内容到云端
saveBtn.addEventListener('click', async () => {
    const content = clipInput.value.trim();
    if (!content) {
        saveStatus.textContent = '⚠️ 请先输入或粘贴内容';
        saveStatus.style.color = '#ff6b6b';
        return;
    }

    saveBtn.disabled = true;
    saveStatus.textContent = '⏳ 正在保存...';
    saveStatus.style.color = '#fff';

    try {
        let response;
        if (editingId) {
            // 更新模式
            response = await fetch(`${API_BASE}/clips/${editingId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content })
            });
        } else {
            // 新建模式
            response = await fetch(`${API_BASE}/clips`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content })
            });
        }

        if (response.ok) {
            saveStatus.textContent = editingId ? '✅ 更新成功！' : '✅ 保存成功！';
            saveStatus.style.color = '#51cf66';
            clipInput.value = '';
            editingId = null;
            saveBtn.textContent = '💾 保存到云端';
            fetchClipList();
            setTimeout(() => { saveStatus.textContent = ''; }, 2000);
        } else {
            saveStatus.textContent = '❌ 保存失败';
            saveStatus.style.color = '#ff6b6b';
        }
    } catch (error) {
        saveStatus.textContent = '❌ 网络错误，请检查服务器';
        saveStatus.style.color = '#ff6b6b';
        console.error('Save Error:', error);
    }

    saveBtn.disabled = false;
});

// 3. 获取剪切板列表
async function fetchClipList() {
    try {
        const response = await fetch(`${API_BASE}/clips`);
        if (!response.ok) throw new Error('Network response was not ok');

        const clips = await response.json();
        clipListUl.innerHTML = '';

        if (clips.length === 0) {
            clipListUl.innerHTML = '<li style="justify-content: center; color: #aaa;">剪切板空空如也~</li>';
            return;
        }

        clips.forEach(clip => {
            const li = document.createElement('li');
            const time = new Date(clip.createdAt).toLocaleString('zh-CN', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });
            li.innerHTML = `
                <div class="clip-info">
                    <div class="clip-content" title="${escapeHtml(clip.content)}">${escapeHtml(clip.preview)}</div>
                    <div class="clip-time">${time}</div>
                </div>
                <div class="action-btns">
                    <button class="btn open-btn" data-id="${clip.id}" data-content="${escapeAttr(clip.content)}">打开</button>
                    <button class="btn copy-btn" data-content="${escapeAttr(clip.content)}">复制</button>
                    <button class="btn delete-btn" data-id="${clip.id}">删除</button>
                </div>
            `;
            clipListUl.appendChild(li);
        });

        // 绑定打开按钮事件
        document.querySelectorAll('.open-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.target.getAttribute('data-id');
                const content = e.target.getAttribute('data-content');
                clipInput.value = content;
                editingId = id;
                saveBtn.textContent = '📝 更新内容';
                clipInput.focus();
                // 滚动到顶部
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
        });

        // 绑定复制按钮事件
        document.querySelectorAll('.copy-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const content = e.target.getAttribute('data-content');
                try {
                    await navigator.clipboard.writeText(content);
                    e.target.textContent = '已复制';
                    e.target.classList.add('copied');
                    setTimeout(() => {
                        e.target.textContent = '复制';
                        e.target.classList.remove('copied');
                    }, 2000);
                } catch (err) {
                    // 降级方案
                    const textarea = document.createElement('textarea');
                    textarea.value = content;
                    document.body.appendChild(textarea);
                    textarea.select();
                    document.execCommand('copy');
                    document.body.removeChild(textarea);
                    e.target.textContent = '已复制';
                    e.target.classList.add('copied');
                    setTimeout(() => {
                        e.target.textContent = '复制';
                        e.target.classList.remove('copied');
                    }, 2000);
                }
            });
        });

        // 绑定删除按钮事件
        document.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.target.getAttribute('data-id');
                if (confirm('确定要删除这条内容吗？')) {
                    deleteClip(id);
                }
            });
        });

    } catch (error) {
        clipListUl.innerHTML = '<li style="justify-content: center; color: #ff6b6b;">⚠️ 无法连接到服务器</li>';
        console.error('Fetch Clips Error:', error);
    }
}

// 4. 删除剪切板内容
async function deleteClip(id) {
    try {
        const response = await fetch(`${API_BASE}/clips/${id}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            saveStatus.textContent = '🗑️ 已删除';
            saveStatus.style.color = '#ff6b6b';
            fetchClipList();
            setTimeout(() => { saveStatus.textContent = ''; }, 2000);
        } else {
            alert('❌ 删除失败');
            fetchClipList();
        }
    } catch (error) {
        console.error('Delete Error:', error);
        alert('❌ 网络错误，无法连接服务器');
    }
}

// HTML 转义函数
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 属性值转义
function escapeAttr(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// 页面加载完成后获取列表
window.addEventListener('DOMContentLoaded', fetchClipList);
