# 来源约定

## 产品交换范围

使用 CoNLL-U 十列文本：空行结束句，# newdoc id 和 # sent_id 为原注释；句身份包含发布分片 id、文档范围与该分片句位置，sent_id 仅作为来源标签。整型 ID 是词节点，a-b 是词面区间，小数形式是空节点，比较小数节点不能用浮点数。基本 HEAD 只引用词节点或 0；DEPS 可引用词或空节点及 0，关系名允许冒号，按第一个冒号分隔节点与关系；多边用 |。词面文本由区间词面或未覆盖的单词组成，SpaceAfter=No 保留；不要把 empty node 加入表面文本。/release 的 id/revision 界定分片替换，同 revision 重领不产生新句。句内错误隔离，但无法确定句边界的截断保留未完成尾部。

## 当前来源路由

- `/primary`：text/plain
- `/corpus/part-a`：text/plain
- `/corpus/part-b`：text/plain
- `/release`：application/json

`/catalog` 提供入口及业务选择。资源字节支持 GET/HEAD、单一 bytes 范围、ETag 和 If-Match，响应不会跨来源重定向。`/_phase` 为联调控制路径，不是产品数据来源，不应由产品自行切换阶段。

## 依据和范围说明

- https://universaldependencies.org/format.html

以上是格式或业务词汇的公开依据；本项目明确限定的交换子集以本文及实际资源为准，未要求完整标准实现。元数据和未支持声明应保留可定位的来源，不把未知转换成已确认的空结果。HTTP 来源状态、原件结构和产品接收完整性是不同层次；现有通用收件接口成功只表示该单件已保存。
