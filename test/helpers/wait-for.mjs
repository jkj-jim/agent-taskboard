/**
 * 等一个最终一致的结果出现。
 *
 * 用墙钟截止时间，不用固定轮询次数：次数不限时间——实际时限是
 * `次数 ×（每次的请求耗时 + 间隔）`，机器一忙就随之漂移，稳定复现不了。
 * 实测就吃过这个亏：一次完整套件里某个断言用掉了 80/100 次预算，
 * 只要再慢一点就变成失败，而失败信息只有一句 `assert.ok(undefined)`。
 *
 * 默认 15 秒是按实测定的：同一条等待空载约 1 秒、并行跑完整套件时见过 2.1 秒。
 * 留足余量的同时仍然是「真坏了就很快报错」，因为条件成立时立刻返回。
 */
export async function waitFor(predicate, { timeoutMs = 15_000, interval = 20, label } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (true) {
    attempts += 1;
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) {
      // 说清等的是什么、等了多久，否则下次超时还是只能靠猜。
      throw new Error(
        `等待超时：${label ?? "condition"}（${timeoutMs}ms，轮询 ${attempts} 次）`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
