// 左侧链接部分
const links = document.querySelector(".links");
const social = document.querySelector(".social");
const tip = document.querySelector(".tip");

links.children[0].addEventListener("mouseenter", function () {
  tip.textContent = "看看github吧~"
})

links.children[1].addEventListener("mouseenter", function () {
  tip.textContent = "通过QQ联系我~"
})

links.children[2].addEventListener("mouseenter", function () {
  tip.textContent = "通过微信联系我~"
})

links.children[3].addEventListener("mouseenter", function () {
  tip.textContent = "进入我的博客看看吧~"
})

social.addEventListener("mouseenter", function () {
  tip.textContent = "随便看看吧~"
})

social.addEventListener("mouseleave", function () {
  tip.textContent = ""
})