# corpus-acquisition

标注语料分片中的词面与依存节点采集相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

接收单件 CoNLL-U 句子，并按发布分片领取多句语料。句身份由分片 id、文档范围（# newdoc id）与分片内句位置构成，sent_id 仅作来源标签，跨分片同号句互不影响。词面、词节点、空节点与增强关系分列保存，词面文本只含区间词面与未覆盖单词，空节点不进入文本。句内错误按句隔离并保留原文，无法确定句边界的截断尾部保留在分片记录中。同 revision 重领幂等，revision 变化整体替换对应分片来源。

`src/reader.mjs` 提供现有单件读取契约；`src/shard.mjs` 是分片解析器；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 保存原件摘要、解释结果与语料状态。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品、领取一件资料、按发布清单领取分片语料、读取已保存的句子与隔离结果，然后关闭服务并清理临时目录。它展示当前产品能力，不模拟尚不存在的能力。演示没有固定等待、外网访问或人工操作，通常数秒结束。扩展产品后可按实际能力更新演示路径；不要以打印预先保存的结果替代运行。

直接 `npm start` 即可启动产品，默认自动在临时回环端口创建本地合成来源，产品默认监听 127.0.0.1:4102。退出产品时同步关闭自带来源。需要联调独立来源时先运行 `npm run source`，再设置 SOURCE_URL=http://127.0.0.1:4101 运行 `npm start`；显式来源不会由产品关闭。DATA_DIR 可设置资料目录，PORT 可覆盖产品监听端口。构建产物位于 dist，启动、测试与演示均不需要外部服务或下载。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。
- GET /records：持久接收目录；同 source URL、同摘要重领返回原 id。
- GET /objects/{digest}：读取已保存的原始字节。
- POST /releases，JSON 可省略 {"path":"/release"}：缺省时先取 /catalog 的 entry 领取发布清单，再按清单领取各分片并替换对应来源；同 revision 重领不产生新句。
- GET /corpus：发布版本与分片清单，含保留的未完成尾部。
- GET /corpus/sentences：句子目录（key、来源边界与词面文本）。
- GET /corpus/sentences/{key}：单句细节，含词面、词节点、空节点与增强关系。
- GET /corpus/quarantine：被隔离的句及原因。

前四项是兼容接口，行为不变；所有 GET 接口保持只读。收件记录只包含单件 raw 对象，分片语料的句子与节点状态保存在资料目录的 corpus.json。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖现有读取器、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界和范围响应；领域读取行为在 test/domain.test.mjs，分片解析与发布领取流程在 test/corpus.test.mjs。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t corpus-acquisition:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
