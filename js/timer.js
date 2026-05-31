// 时钟日期天气逻辑
const data = document.querySelector(".data");
const time = document.querySelector(".time");
const location = document.querySelector(".location");
const footer = document.querySelector("footer");
const netStatTime = Date.UTC(2026, 2, 15, 0, 0, 0);  // 建站时间

let moonLanding = new Date();
let year = moonLanding.getFullYear();
let month = moonLanding.getMonth() + 1;
let day = moonLanding.getDate();

year < 10 ? year = "0" + year : null;
month < 10 ? month = "0" + month : null;
day < 10 ? day = "0" + day : null;
data.children[0].textContent = year + "年";
data.children[1].textContent = month + "月";
data.children[2].textContent = day + "日";

setInterval(() => {
  moonLanding = new Date();
  let hour = moonLanding.getHours();
  let minute = moonLanding.getMinutes();
  let second = moonLanding.getSeconds();
  hour < 10 ? hour = "0" + hour : null;
  minute < 10 ? minute = "0" + minute : null;
  second < 10 ? second = "0" + second : null;
  const fullTime = `${hour}:${minute}:${second}`;
  time.textContent = fullTime;
  // 网站运行时间
  const processTime = Math.floor((Date.now() - netStatTime) / 1000);
  const netday = Math.floor(processTime / (60 * 60 * 24));
  const nethour = Math.floor((processTime % (60 * 60 * 24)) / (60 * 60));
  const netminute = Math.floor((processTime % (60 * 60)) / 60);
  const netsecond = processTime % 60;
  footer.children[0].textContent = `已运行 ${netday} 天 ${nethour} 小时 ${netminute} 分钟 ${netsecond} 秒`
}, 1000)

// 获取用户地址api
fetch("https://restapi.amap.com/v3/ip?key=8947c5908f33a40f5b51f39fdef06236").then(response => {
  return response.json();
}).then(response => {
  location.children[0].textContent = response.city;
  return response.adcode
}).then((adcode) => {
  // 获取用户天气api
  fetch(`https://restapi.amap.com/v3/weather/weatherInfo?key=8947c5908f33a40f5b51f39fdef06236&city=${adcode}`).then(response => {
    return response.json();
  }).then(response => {
    location.children[1].textContent = response.lives[0].weather;
    location.children[2].textContent = response.lives[0].temperature + "°C";
  }).catch(err => {
    location.innerHTML = "<span>天气获取失败</sapn>"
    console.log(err);
  })
}).catch(err => {
  location.innerHTML = "<span>天气获取失败</sapn>"
  console.log(err);
})

