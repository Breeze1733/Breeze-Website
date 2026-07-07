// js/transfer.js
const API_BASE = window.__TRANSFER_API_BASE__ || '/transfer-api';

const fileInput = document.getElementById('file-input');
const fileNameDisplay = document.getElementById('file-name-display');
const uploadBtn = document.getElementById('upload-btn');
const uploadStatus = document.getElementById('upload-status');
const fileListUl = document.getElementById('file-list');
const progressContainer = document.getElementById('progress-container');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');

// 1. 监听文件选择变化，更新 UI 显示的文件名
fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
        fileNameDisplay.textContent = fileInput.files[0].name;
    } else {
        fileNameDisplay.textContent = '未选择任何文件';
    }
});



// 2. 上传文件逻辑 (使用 XHR 以支持进度条)
uploadBtn.addEventListener('click', () => {
    const file = fileInput.files[0];
    if (!file) {
        uploadStatus.textContent = '⚠️ 请先点击左侧选择文件';
        uploadStatus.style.color = '#ff6b6b';
        return;
    }

    const formData = new FormData();
    formData.append('file', file);

    // 显示进度条，重置状态
    progressContainer.classList.remove('hidden');
    progressBar.style.width = '0%';
    progressText.textContent = '0%';
    uploadStatus.textContent = '⏳ 正在上传...';
    uploadStatus.style.color = '#fff';
    uploadBtn.disabled = true;

    // 创建 XHR 对象
    const xhr = new XMLHttpRequest();

    // 【关键核心】监听上传进度
    xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
            const percentComplete = Math.round((e.loaded / e.total) * 100);
            progressBar.style.width = percentComplete + '%';
            progressText.textContent = percentComplete + '%';
        }
    });

    // 监听上传完成
    xhr.onload = function() {
        if (xhr.status === 200) {
            try {
                const resp = JSON.parse(xhr.responseText);
                uploadStatus.textContent = '✅ ' + (resp.message || '上传成功！');
            } catch {
                uploadStatus.textContent = '✅ 上传成功！';
            }
            uploadStatus.style.color = '#51cf66';
            fileInput.value = '';
            fileNameDisplay.textContent = '未选择任何文件';
            fetchFileList(); // 刷新列表
            setTimeout(() => progressContainer.classList.add('hidden'), 2000);
        } else {
            let msg = '❌ 上传失败';
            try {
                const err = JSON.parse(xhr.responseText);
                if (err.error) msg = '❌ ' + err.error;
            } catch {}
            uploadStatus.textContent = msg;
            uploadStatus.style.color = '#ff6b6b';
        }
        uploadBtn.disabled = false;
    };

    // 监听错误
    xhr.onerror = function() {
        uploadStatus.textContent = '❌ 网络错误，请检查服务器';
        uploadStatus.style.color = '#ff6b6b';
        uploadBtn.disabled = false;
    };

    // 发送请求
    xhr.open('POST', `${API_BASE}/upload`, true);
    xhr.send(formData);
});

// 3. 获取文件列表逻辑
async function fetchFileListOnce() {
    const response = await fetch(`${API_BASE}/files`, {
        cache: 'no-store'
    });

    if (!response.ok) {
        throw new Error(`Network response was not ok (${response.status})`);
    }

    return response.json();
}

async function fetchFileList() {
    try {
        let files;

        try {
            files = await fetchFileListOnce();
        } catch (error) {
            await new Promise(resolve => setTimeout(resolve, 300));
            files = await fetchFileListOnce();
        }

        fileListUl.innerHTML = ''; // 清空现有列表
        
        const visibleFiles = files.filter(file => file.name !== '.gitkeep');

        if (visibleFiles.length === 0) {
            fileListUl.innerHTML = '<li style="justify-content: center; color: #aaa;">云端空空如也~</li>';
            return;
        }

        visibleFiles.forEach(file => {
            const li = document.createElement('li');
            li.innerHTML = `
                <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%;" title="${file.name}">📄 ${file.name}</span>
                <div class="action-btns">
                    <a href="${API_BASE}/download/${encodeURIComponent(file.name)}" download class="btn download-btn">下载</a>
                    <button class="btn delete-btn" data-filename="${file.name}">删除</button>
                </div>
            `;
            fileListUl.appendChild(li);
        });

        // 给所有新生成的删除按钮绑定点击事件
        document.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const filename = e.target.getAttribute('data-filename');
                // 弹出确认框防止误删
                if (confirm(`确定要彻底删除文件 "${filename}" 吗？`)) {
                    deleteFile(filename);
                }
            });
        });

    } catch (error) {
        fileListUl.innerHTML = '<li style="justify-content: center; color: #ff6b6b;">⚠️ 无法连接到服务器获取列表</li>';
        console.error('Fetch List Error:', error);
    }
}

// 4. 删除文件逻辑
async function deleteFile(filename) {
    try {
        // 使用 encodeURIComponent 防止文件名中有空格或特殊字符导致请求失败
        const response = await fetch(`${API_BASE}/files/${encodeURIComponent(filename)}`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            uploadStatus.textContent = `🗑️ "${filename}" 已删除`;
            uploadStatus.style.color = '#ff6b6b';
            fetchFileList(); // 删除成功后自动刷新列表
        } else {
            alert('❌ 删除失败，可能文件已被其他人删除了');
            fetchFileList(); // 刷新一下同步最新状态
        }
    } catch (error) {
        console.error('Delete Error:', error);
        alert('❌ 网络错误，无法连接服务器');
    }
}

// 页面加载完成后获取文件列表
// 兼容 type="module" 脚本执行时机：如果 DOM 已就绪则直接执行，否则等待事件
function init() {
    fetchFileList();
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}