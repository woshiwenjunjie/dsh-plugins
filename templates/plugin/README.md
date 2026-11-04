# dsh-my-plugin

> npm 包名带不带 scope 都行；如果名字被占用，用 `@你的账号/dsh-xxx`。

一句话说明这个插件做什么。

## 安装

```bash
dsh plugin --profile web add dsh-my-plugin
# 本地开发
dsh plugin --profile web add link:<本目录绝对路径>
```

## 用法

- 装上后页面右下角出现一个徽标（骨架默认行为，换成你的界面）。

## 数据

（说明数据存在哪、是否发网络请求。默认：只存本机浏览器，不上报。）

## 开发

```bash
node test/smoke.mjs   # 冒烟测试
node ../../scripts/check.mjs
```

## License

MIT
