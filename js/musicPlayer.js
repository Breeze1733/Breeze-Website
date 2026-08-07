// 内嵌音乐播放器播放逻辑
const dot = document.querySelector(".dot");
const fullSlider = document.querySelector(".fullSlider");
const slider = document.querySelector(".slider");
const pause = document.querySelector(".pause");
const start = document.querySelector(".start");
const left = document.querySelector(".left");
const right = document.querySelector(".right");
const audio = document.querySelector("audio");
const img = document.querySelector(".sound img");
const songTitle = document.querySelector(".music h3");
let checkMoveTimer;   // 用于存储定时器
let startX, moveX;    // 存储鼠标坐标
let beforeSound = 20, realSound = 20;      // 点击静音前的音量和目前的音量 70px为满

// 动态播放列表
let playlist = [];
let currentSrc = '';  // 跟踪当前播放的歌曲 src

// 从服务器获取最新播放列表（重新扫描 audio 文件夹）
async function fetchPlaylist() {
  try {
    const res = await fetch('/api/audio-list');
    if (!res.ok) throw new Error('获取失败');
    return await res.json();
  } catch (e) {
    console.warn('获取播放列表失败，使用缓存列表', e);
    return null;
  }
}

// 切换歌曲，direction: -1（上一首）或 1（下一首）
async function switchSong(direction) {
  // 每次切歌时重新扫描 audio 文件夹
  const newList = await fetchPlaylist();
  if (newList && newList.length > 0) {
    playlist = newList;
  }

  if (playlist.length === 0) return;

  // 在最新列表中定位当前歌曲
  let idx = playlist.findIndex(s => s.src === currentSrc);
  if (idx === -1) {
    // 当前歌曲已被删除，从第一首开始
    idx = 0;
  } else {
    idx = (idx + direction + playlist.length) % playlist.length;
  }

  const song = playlist[idx];
  currentSrc = song.src;
  audio.src = song.src;
  songTitle.textContent = song.title;
  audio.play();
  start.classList.add("hidden");
  pause.classList.remove("hidden");
}

// 下一首
function nextSong() {
  switchSong(1);
}

// 上一首
function prevSong() {
  switchSong(-1);
}

// 初始化：获取播放列表并记录当前默认歌曲
async function initPlaylist() {
  const songs = await fetchPlaylist();
  if (songs && songs.length > 0) {
    playlist = songs;
  }
  // 用文件名做匹配（避免编码差异）
  const rawSrc = audio.getAttribute('src');  // 形如 ./audio/刘德华 - 十七岁.mp3
  const rawName = rawSrc ? rawSrc.split('/').pop() : '';  // 提取文件名
  const match = playlist.find(s => {
    const sName = decodeURIComponent(s.src.split('/').pop());
    return sName === rawName;
  });
  if (match) {
    currentSrc = match.src;
  } else if (playlist.length > 0) {
    // HTML 中 src 与服务器列表不一致时，自动纠正到列表第一首
    currentSrc = playlist[0].src;
    audio.src = playlist[0].src;
    songTitle.textContent = playlist[0].title;
  } else {
    currentSrc = rawSrc;
  }
}

initPlaylist();

// 禁止冒泡,以防mobilePhone模式，冒泡执行到timer的点击事件
function stopPao(e) {
  if (!e) var e = window.event;
  e.cancelBubble = true;
  if (e.stopPropagation) e.stopPropagation();
}

function adjustSound(sound = realSound) {   // 调节音量
  if (sound <= 0) {
    sound = 0;
    img.setAttribute("src", "./images/静音.png");
  } else if (sound >= 70) {
    sound = 70;
    img.setAttribute("src", "./images/sound.png");
  } else {
    img.setAttribute("src", "./images/sound.png");
  }
  realSound = sound;
  dot.setAttribute("style", `left:${sound}px`);
  fullSlider.setAttribute("style", `width:${sound + 6}px`); // 小圆点有6px的右偏差
  audio.volume = (sound / 70).toFixed(2);
  startX = moveX;
}

// 鼠标，手指移动
function mouseMoveEvent(e) {
  // console.log("鼠标移动了");
  e.preventDefault(); // 阻止默认事件防止恶心的bug，烦死我了
  moveX = e.clientX
}

function fingerMoveEvent(e) {
  moveX = e.touches[0].clientX;
}

// 鼠标,手指按下
function downEvent(e) {
  stopPao(e);
  // console.log("鼠标点击了");
  e.touches ? (startX = e.touches[0].clientX) : (startX = e.clientX);
  document.addEventListener("mousemove", mouseMoveEvent);
  document.addEventListener("touchmove", fingerMoveEvent, { passive: false });
  checkMoveTimer = setInterval(() => {
    const oldSound = fullSlider.clientWidth - 6;
    const difference = moveX - startX;
    const sound = oldSound + difference;
    adjustSound(sound);
  }, 100);
}

// 鼠标，手指抬起
function upEvent() {
  // console.log("鼠标松开了");
  document.removeEventListener("mousemove", mouseMoveEvent);
  document.removeEventListener("touchmove", fingerMoveEvent, { passive: false });
  clearInterval(checkMoveTimer);
}

dot.addEventListener("mousedown", downEvent);
dot.addEventListener("touchstart", downEvent, { passive: false });

document.addEventListener("mouseup", upEvent);
document.addEventListener("touchend", upEvent);

slider.addEventListener("click", function (e) {
  stopPao(e)
  e.target === dot ? null : adjustSound(e.offsetX)
})

img.addEventListener("click", function (e) {
  stopPao(e)
  // 不想用if了，这样搞的
  img.src.includes("sound") ? (beforeSound = realSound) && adjustSound(0) : adjustSound(beforeSound);
})

start.addEventListener("click", function (e) {
  stopPao(e)
  // 首次播放时同步 currentSrc
  if (!currentSrc) {
    currentSrc = audio.getAttribute('src');
  }
  audio.play();
  start.classList.add("hidden");
  pause.classList.remove("hidden");
})

pause.addEventListener("click", function (e) {
  stopPao(e);
  audio.pause();
  pause.classList.add("hidden");
  start.classList.remove("hidden");
})

// 上一首
left.addEventListener("click", function (e) {
  stopPao(e);
  prevSong();
});

// 下一首
right.addEventListener("click", function (e) {
  stopPao(e);
  nextSong();
});

// 当前歌曲播放完后自动切到下一首
audio.addEventListener("ended", function () {
  nextSong();
});

adjustSound();  // 首次执行一下
