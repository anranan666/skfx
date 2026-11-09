# 深空防线

摄像头手势控制的塔防小游戏，MediaPipe Hands 本地推理，21 关键点识别指尖与抢合手势。纯静态原生 JS，无构建依赖。

## 玩法

守住画面中心的星核，撑过五波。指尖移动准星，抢合发射脉冲，按住蓄能，张掌释放冲击波。

## 运行

任选一种：

1. 直接双击 index.html 打开，用键鼠模式（浏览器禁止本地文件调用摄像头）
2. 在本目录执行 `python3 -m http.server 8123`，访问 http://localhost:8123/ ，摄像头可用

## 结构

```
index.html
css/style.css
js/config.js
js/gesture-detector.js
js/game.js
js/app.js
lib/mediapipe/    手势模型
```
