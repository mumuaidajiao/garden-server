# garden · 服务端

两台设备之间的中转站。她那一端（[garden-app](https://github.com/mumuaidajiao/garden)）发过来的东西经过这里，
**外加一层情绪判断和危机护栏** —— 这层是这个项目存在的主要理由。

```
她端 App  ──►  relay.js  ──►  你端（自建）
                  │
                  ├─ 硬词表（本地，零成本，先过一遍）
                  ├─ judgeMood   （独立一次调用 → CRISIS / LOW / OK）
                  └─ 正常对话（并行跑，所以总延迟 ≈ 1.5 秒而不是 3 秒）
```

## 跑起来

```bash
node -e "const c=require('crypto');console.log('HER: MUMU-H-'+c.randomBytes(8).toString('hex'));console.log('HIM: MUMU-M-'+c.randomBytes(8).toString('hex'))"
cp config.example.json config.json     # 然后填 key、令牌、提示词
npm i lunar-javascript                 # 可选：要农历纪念日才装
node relay.js                          # 默认 127.0.0.1:9394
```

**零必需依赖** —— 除上面那个可选项，只用 Node 内置模块。

生产环境用 pm2 或 systemd 托管：

```bash
pm2 start relay.js --name garden && pm2 save
```


**首次部署要建两个目录**（图库和歌单，没有会自动跳过，但功能就是空的）：

```bash
mkdir -p gallery/{lost,gloomy,excited,happy,yearning,wistful,moved,bliss} music
```

## 接口

服务器同时兼容 `/mumu/api` 和 `/api` 两种前缀 —— 客户端填的地址末尾带不带
一段路径都能用。

| 分组 | 接口 |
|---|---|
| 健康 | `GET /health` |
| 她 → 你 | `POST /ping`（想你啦）、`/knock`（打扰一下）、`/say`、`/voice`、`/shake`、`/fromher` |
| 你 → 她 | `POST /fromhim`、`/reply`、`/notify`、`/status`、`GET /herpoll`、`/pull` |
| 对话 | `GET /thread`、`/chat`、`GET/POST /calendar`、`/calendar/delete` |
| 静音 | `GET/POST /quiet`（「我不想用这个了」）、`GET/POST /notify`（通知开关） |
| 媒体 | `GET/POST /avatar`、`GET /audio`、`/image`、`/gallery/random`、`/music/list`、`/music/get`、`POST /music/upload` |

### `quiet` 和 `notifyLevel` 是两回事

- `notifyLevel`（通知开关）：`all` / `crisis` —— 「只推危机」，是她的选择权
- `quiet`（「我不想用这个了」）：更重的一档

⚠️ **`quiet` 不能一刀切。** 曾经它是"什么都不推"，结果她按完出口再按「想你啦」，
对方手机一点动静都没有
现在的语义是：**她主动发起的照推**（想你啦 / 打扰一下 / 她说的话 / 摇一摇 / **危机**），
只停「主动开口」和常驻服务。

### 数据

全部在 `data.json`（脚本同目录），原子写（先写 `.tmp` 再 rename）。
会话最多留 200 个，180 天自动清理。**备份就是备份这个文件** —— 它同时是她的
聊天记录、日历、状态和留言。图片和歌是单独的文件（`avatar.jpg` / `gallery/` / `music/`），
不塞进 json（不然每次 saveData 都要整个序列化一遍）。

## 反代（可选）

监听的是 `127.0.0.1:9394`，要外部访问就配一层 nginx：

```nginx
location /mumu/ {
    proxy_pass http://127.0.0.1:9394/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    client_max_body_size 24m;    # ⚠️ 默认只有 1m
}
```

> ⚠️ **`client_max_body_size` 默认是 1MB**，一段 30 秒的语音 base64 之后约 1.3MB，
> 会被拦在门外、返回一个 HTML 错误页，客户端只看到 `HTTP 413` ——
> 表现出来就是"语音发不出去"，而且完全不知道为什么。

## License

[MIT](LICENSE)
