# BeDD 模式（transport: 'bedd'）

本页说明当 bedboo 不再自己处理协议、而是驱动由 Be.D.D. 托管的真实 Bedrock 客户端（`transport: 'bedd'`）时有哪些变化。
仅涉及 `bedd` 传输：使用 `raknet` / `nethernet` 时本页内容均不适用。配置方法、权限归属表和覆盖矩阵见
[BeDD 指南](../../guide/bedd.md)。

## 真实客户端负责自己的上行数据包  {#client-owned-packets}

- **影响：** 所有会发送数据包的 API；`bot._client.queue` / `write`
- **Java：** mineflayer 本身就是客户端，所有数据包都由它自己写出。
- **Bedrock：** 由 BeDD 托管的客户端自己登录、应答加载界面、请求区块，并每 tick 自己发送 `player_auth_input`、方块操作、
  物品栏事务（inventory transaction）和物品堆叠请求（item stack request）。
- **bedboo：** 从不伪造这些数据包。一个路由器把 bedboo 原本要发送的内容转换为 BeDD 控制操作（`input`、`look`、`slot`、
  `button`、`action`、`send`、`stack`）；属于客户端的数据包会被丢弃（见
  [权限归属表](../../guide/bedd.md#authority-table)）。

## `bot.entity` 跟随客户端，滞后 1-2 tick  {#self-state-from-echo}

- **影响：** `bot.entity.position` / `velocity` / `yaw` / `pitch` / `onGround`、`physicsTick`、`move`、
  `bot.physicsEnabled`、mineflayer-pathfinder
- **Java：** mineflayer 的物理引擎每 tick 预测玩家状态。
- **Bedrock（bedd）：** 玩家由客户端自己的物理引擎移动；tap 会回显客户端发出的每个 `player_auth_input`。
- **bedboo：** 物理提供者不自行步进，而是复制回显（眼睛高度 − 1.62），每个客户端 tick 触发一次 `physicsTick` 和 `move`；
  当回显与目标的偏差在 0.5° 以内时，`look` / `lookAt` 才 resolve。行走、pathfinder 目标和 `lookAt` 均可用；pathfinder
  运行时有 1-2 tick 的延迟。

## 点击落在客户端准星所指之处  {#client-raycast}

- **影响：** `dig`、`placeBlock`、`activateBlock`、`activateEntity`、`attack`
- **Java：** mineflayer 在数据包中直接指定方块 / 面 / 实体。
- **Bedrock（bedd）：** 客户端转向目标并点击；命中什么由它自己的射线检测决定。
- **bedboo：** 先转向，等待视角收敛，再发送 `button`；结果从 `update_block` 和实体事件中读取，因此点击落到相邻方块上时
  也能如实反映出来。

## 不支持界面级操作  {#screen-actions}

- **影响：** `bot.writeBook`、`bot.updateSign`、`bot.respawn`、通过床的界面入睡 / 起床
- **Java：** bedboo 可以自己发送对应的数据包。
- **Bedrock（bedd）：** 这些都是真实客户端的界面；BeDD 目前还没有对应的操作（计划在 v2 提供）。
- **bedboo：** 这些调用会抛出或 reject `BeddUnsupportedError`（`code: 'ERR_BEDD_UNSUPPORTED'`、`bedd: true`、
  `feature`、`missing`）；需要用户在客户端上点击“重生”。

## 物品栏操作需要 `stack` 操作  {#inventory-stack}

- **影响：** `clickWindow`、`moveSlotItem`、`transfer`、`deposit`、`withdraw`、`putAway`、`craft`、从主物品栏 / 盔甲 /
  副手执行的 `equip`、`unequip`、`tossStack`、`creative.setInventorySlot`、铁砧 / 附魔台 / 村民交易 / 锻造台
- **Java：** 窗口点击。
- **Bedrock（bedd）：** 物品堆叠请求必须经过客户端的 ItemStackNetManager，否则客户端的请求 id 和预测的物品栏会失去同步。
- **bedboo：** 启用 BeDD 的 `stack` 操作（`allowStack: true`）后这些调用可用，bedboo 的请求 id 会映射到客户端的请求 id；
  未启用时它们会以 `ERR_BEDD_UNSUPPORTED` reject。

## 连接选项归客户端所有  {#ignored-options}

- **影响：** `createBot` 选项 `auth`、`username`、`host`、`port`、`viewDistance`、`skipPing`；`holdResourcePacks`；
  `bot.end`、`bot.quit`
- **Java：** 由 mineflayer 负责连接、认证和断开。
- **Bedrock（bedd）：** 客户端已经登录并处于某个世界中。
- **bedboo：** 这些选项会被忽略，每个各输出一次警告；`holdResourcePacks` 不起作用；`bot.end` / `quit` 只会断开挂接
  （客户端仍留在它的世界中）。客户端切换世界（`LINK_DOWN`）会结束 bot。
