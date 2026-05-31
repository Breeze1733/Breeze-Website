// 移动端菜单按钮
const menu = document.querySelector(".menu");
const menuquit = document.querySelector(".menuquit")
const sections = document.querySelectorAll("main section");
const timer = document.querySelector(".timer");
const music = document.querySelector(".music");

let onlyAddClick = false;  // 仅添加一次点击函数
let onlyRemoveClick = true;  // 仅去除一次点击事件

menu.onclick = function () {
  sections[1].setAttribute("style", "display:flex");
  sections[0].setAttribute("style", "display:none");
}

menuquit.onclick = function () {
  sections[0].setAttribute("style", "display:flex");
  sections[1].setAttribute("style", "display:none");
}

// 检测到达平板宽度时，取消额外的style样式
window.addEventListener("resize", function () {
  let pageWidth = window.innerWidth;
  if (pageWidth > 700) {
    sections[0].removeAttribute("style");
    sections[1].removeAttribute("style");
    onlyRemoveClick ? true : removeClickEvent();
  } else if (pageWidth < 700) {
    onlyAddClick ? true : addClickEvent();
  }
})

// 首先先判断一下窗口大小
window.innerWidth < 700 ? addClickEvent() : null;

// 切换timer和music的隐藏显示
function toggleStyle(e) {
  timer.classList.toggle("phoneStyle");
  music.classList.toggle("phoneStyle");
}

function addClickEvent() {
  timer.addEventListener("click", toggleStyle);
  music.addEventListener("click", toggleStyle);
  onlyRemoveClick = false;
  onlyAddClick = true;
}

function removeClickEvent() {
  timer.removeEventListener("click", toggleStyle);
  music.removeEventListener("click", toggleStyle);
  onlyAddClick = false;
  onlyRemoveClick = true;
}
