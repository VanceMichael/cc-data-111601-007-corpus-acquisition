# corpus-acquisition

标注语料分片中的词面与依存节点采集相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

- 兼容的单件收件：`POST /intakes` 按现有 reader 解释一份 CoNLL-U 单句，保存原件摘要与结果。
- 分片领取：`POST /claims` 读取来源的发布清单，逐件领取清单中的 CoNLL-U 分片，保留文档范围与分片内句子位置。
- 分层保存：可显示词面、词节点与增强关系分别记录；词面区间只提供显示文本，空节点不进入原句文本。
- 修订替换：清单中的 `revision` 升高时，该分片整体替换；同 revision 重领幂等，低 revision 拒绝且不产生部分写入。
- 按来源查询：`GET /shards`、`GET /sentences`、`GET /sentences/{shard}/{position}`。

## 句、词面与节点

CoNLL-U 十列文本按空行切句。每句的身份是 **分片 id + 分片内位置**，`# sent_id` 只作为来源标签保存，不参与唯一性；相邻文件都能有 `s1`，但不会互相覆盖。文档范围取 `# newdoc id`，在同分片后续句子中延续，因此文档边界在同一个分片内可见。

句子内分别记录：

- `spans`：`a-b` 词面区间，只有 `form` 用于显示；它覆盖的词节点仍各自保留。
- `words`：整型 ID 的词节点，带十列和基本 HEAD/关系。
- `empties`：小数 ID 的空节点，按整数分量比较（`3.1` 与 `3.10` 不同），可被增强 `DEPS` 引用。
- `surface`：由区间词面与未被区间覆盖的单词重建的显示文本；`SpaceAfter=No` 保留，空节点不参与。
- `basic` / `enhanced`：基本关系与增强关系分开记录，增强关系可以指向空节点。

`# text` 只用于比对来源声明；与重建词面不一致记警告，不覆盖重建结果。

## 隔离与截断

某句的 HEAD、增强 `DEPS`、区间覆盖或环不闭合时，只将该句标为 `isolated`：保留 `raw` 行以便定位，但不发布词面、词节点或关系层，其他句子不受影响。分片末尾缺少空行且末行不完整时，保留未完成尾部并标为 `truncated`，不确认成句；完整到达文件末尾的句子正常接收。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品、领取一个发布清单、按来源打印句子分层结果，然后关闭服务并清理临时目录。演示没有固定等待、外网访问或人工操作，通常数秒结束。

分开运行时，先 `npm run source`，来源监听 127.0.0.1:4101；在另一终端设置 SOURCE_URL=http://127.0.0.1:4101 后运行 `npm start`，产品默认 4102。DATA_DIR 可设置资料目录，PORT 可分别覆盖监听端口。构建产物位于 dist。

## 接口

兼容接口（行为不变）：

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。
- GET /records：单件收件目录；同 source URL、同摘要重领返回原 id。
- GET /objects/{digest}：读取已保存的原始字节。

新增接口：

- POST /claims，JSON 为 {"path":"/release"}：从配置来源领取发布清单中的全部分片。清单为 `{"edition":"…","files":[{"id","path","revision"}]}`；所有分片先校验 revision，再整体提交。返回每件的 `status`（`created`、`replaced`、`unchanged`）与 `conflict`。
- GET /shards：已领取分片目录，含文件 id、路径、revision、摘要、文档范围与句数。
- GET /sentences[?shard=&doc=]：所有句子，带分片、文档和位置来源。
- GET /sentences/{shard}/{position}：按分片与位置取一句。

`position` 形如 `s1`，是分片内从 1 开始的位置，不是全局编号。GET 请求不产生写操作。收件记录只包含已领取的原件与解释，不代表关联资料完整。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖读取器、畸形输入、真实 HTTP 领取、分片解析分层、句身份、单句隔离、修订替换、持久重开、同源边界和范围响应。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t corpus-acquisition:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
