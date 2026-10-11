# contract/openapi.json

本文件是 **`pim-api` 仓契约的只读快照**，仅供本仓开发时对照，**不要手工编辑**。

- 来源：`2746267826/pim-api` 的 `contract/openapi.json`（该仓 CI 从 Test 实例导出并硬校验与代码同步）
- 来源元数据（上游 ref 与内容哈希）：见 `contract/provenance.json`（唯一来源，由 `scripts/ci/fetch-contract.sh` 写出）
- 文件 sha256：`1cf261973833a0690b09d2f2eda916de382359636259ab8ed55a8bb38f1aec98`

## 为什么要放进本仓

本仓需要调用后端接口，但**不要凭猜测调用**。契约里有什么，才能调什么；契约里没有的，
就不要写进代码 —— 那是「需要新接口」的信号，按 `AGENTS.md` 的「接口契约与门禁」一节
把需求交给用户，由后端在 `pim-api` 实现并更新契约。

## 怎么刷新

后端契约更新后（用户告知，或你发现契约里缺了已有字段）：

```bash
scripts/ci/fetch-contract.sh
```

脚本会同时更新 **契约快照**（`contract/openapi.json`）、**生成类型**
（`client-web/src/api/generated.ts`）与**来源记录**（`contract/provenance.json`）。**三者都要一并提交**，
并在 PR 里说明刷新原因。

来源记录里写的是**不可变提交 SHA**与**快照内容的 sha256**：传分支名（如 `master`）时，脚本会先用
`git ls-remote` 向公开只读上游解析成提交，再按该提交取一次契约并比对字节；解析不到或两次字节不一致
都会让脚本以非零退出。这一步在 CI 里真实执行，不依赖本地 clone，也没有 skip 分支。

## 新鲜度门禁（与 CI 实际行为一致）

`ci.yml` 的 `Verify client contract is up to date` 步骤会真实运行 `fetch-contract.sh`，
然后检查 `contract/openapi.json` **与** `client-web/src/api/generated.ts` 是否都与拉到的
权威契约一致；只要有一个不一致，该步骤失败（因此 `build-web` 失败、`CI Gate` 失败）。
所以「快照落后」是**会**让本仓 CI 变红的，必须刷新到与 pim-api 一致。

生成物校验失败时，正确动作是运行 `scripts/ci/fetch-contract.sh` 并提交结果，
**不是**手改 `generated.ts`，也不是手工扩写 `contract/openapi.json` 来掩盖差异。

## 注意

- **接入新字段前必须先刷新**，否则对接的是过期形状。
- 手写模型对不上契约时，编译/构建不会报错，问题只会在运行时出现。改接口相关代码前，先对照本文件。
- `contract/openapi.json` 里仍有大量 operation 的 2xx 响应没有 schema、没有 security 声明；
  这些维度在客户端无法机械核对，按 `NOT-VERIFIED` 处理，不要自行编造响应类型来「补齐」。
