/**
 * SubAgent Demo — Тестирование сабагентов в Pi
 * 
 * Использование: pi -e extensions/test/subagent-demo.ts
 * 
 * Демонстрирует:
 * 1. agent_spawn — создание сабагента
 * 2. agent_join — ожидание результата
 * 3. agent_list — список агентов
 * 4. agent_continue — продолжение работы агента
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
	// Команда для быстрого теста сабагентов
	pi.registerCommand("test-agents", {
		description: "Запустить демо-тест сабагентов",
		handler: async (_args, ctx) => {
			ctx.ui.notify("🚀 Запуск демо сабагентов...", "info");
			
			// Демонстрационные задачи для сабагентов
			const demoTasks = [
				{
					name: "math-expert",
					task: "Реши уравнение: 2x² + 5x - 3 = 0. Покажи все шаги решения.",
					tags: "read_only",
					tier: "low"
				},
				{
					name: "file-analyzer", 
					task: "Проанализируй файл extensions/examples/agent-team.ts. Опиши его структуру и ключевые компоненты.",
					tags: "read_only",
					tier: "medium"
				},
				{
					name: "code-reviewer",
					task: "Проведи code review для файла extensions/base/base-agents.ts. Сосредоточься на архитектуре и потенциальных проблемах.",
					tags: "read_only",
					tier: "medium"
				}
			];
			
			let output = "📋 Демо задачи для сабагентов:\n\n";
			demoTasks.forEach((t, i) => {
				output += `${i + 1}. **${t.name}**\n   Задача: ${t.task.slice(0, 80)}...\n   Теги: ${t.tags}, Tier: ${t.tier}\n\n`;
			});
			
			output += "\n💡 Для запуска используй инструмент agent_spawn с этими параметрами.\n";
			output += "   Пример: agent_spawn({ task: \"...\", name: \"math-expert\", tags: \"read_only\", tier: \"low\" })";
			
			pi.sendMessage({
				customType: "demo-tasks",
				content: output,
				display: true
			});
		}
	});
	
	// Команда для параллельного запуска всех тестовых агентов
	pi.registerCommand("run-test-agents", {
		description: "Параллельно запустить всех тестовых агентов",
		handler: async (_args, ctx) => {
			ctx.ui.notify("🚀 Параллельный запуск тестовых агентов...", "info");
			
			// Эта команда просто выводит инструкции - реальный запуск через agent_spawn
			pi.sendMessage({
				customType: "parallel-demo",
				content: `Для параллельного запуска всех агентов используй:\n\n` +
						`1. agent_spawn({ name: "math-expert", task: "Реши: 2x² + 5x - 3 = 0", tier: "low" })\n` +
						`2. agent_spawn({ name: "file-analyzer", task: "Проанализируй extensions/examples/agent-team.ts", tier: "medium" })\n` +
						`3. agent_spawn({ name: "code-reviewer", task: "Review extensions/base/base-agents.ts", tier: "medium" })\n\n` +
						`Затем используй agent_wait_all или agent_join для каждого агента.`,
				display: true
			});
		}
	});
	
	// Информация при старте
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.notify(
			"SubAgent Demo Extension loaded\n" +
			"Команды:\n" +
			"  /test-agents      — показать демо-задачи\n" +
			"  /run-test-agents  — инструкции для параллельного запуска",
			"info"
		);
	});
}
