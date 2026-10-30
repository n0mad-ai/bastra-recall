/** Invented rules only. Translations are test data, never a language detector. */
export const languages = {
  de: { always: 'Nenne in Prüfberichten den erfundenen Planeten Lumo.', when: 'Bei jedem Prüfbericht', correspondence: 'Wenn eine Nachricht einer anderen Person eingefügt oder eine Antwort entworfen wird', reply: 'Antworte mit einem Entwurf zur Prüfung; prüfe vor Ausgabe die Länge.', coding: 'Beim Ändern von erfundenem Code', github: 'Bei Änderungen an Issues und Pull Requests', incoming: 'Mara schreibt: Kannst du morgen die Zeichnung mitbringen?', draft: 'Ja, ich bringe die Zeichnung morgen mit.', question: 'Warum ist der Himmel blau?', calculation: 'Was ist 17 + 25?', ok: 'ok', code: 'Programmausgabe: 42' },
  en: { always: 'Name the invented planet Lumo in test reports.', when: 'In every test report', correspondence: 'When a message from another person is pasted or a reply is drafted', reply: 'Provide a draft for review; check its length before delivery.', coding: 'When changing invented code', github: 'When changing issues and pull requests', incoming: 'Mara writes: Could you bring the drawing tomorrow?', draft: 'Yes, I will bring the drawing tomorrow.', question: 'Why is the sky blue?', calculation: 'What is 17 + 25?', ok: 'ok', code: 'Program output: 42' },
  ja: { always: '検査報告では架空の惑星ルモに言及する。', when: 'すべての検査報告を作成するとき', correspondence: '他の人からのメッセージが貼り付けられたとき、または返信の下書きを作るとき', reply: '確認用の下書きを示し、出力前に文字数を検証する。', coding: '架空のコードを変更するとき', github: 'Issueやプルリクエストを変更するとき', incoming: 'マラから：明日、図面を持ってきてもらえますか。', draft: 'はい、明日図面を持っていきます。', question: '空はどうして青いのですか。', calculation: '17足す25はいくつですか。', ok: '了解', code: 'プログラムの出力：42' },
  ru: { always: 'Упоминай вымышленную планету Лумо в отчётах проверки.', when: 'При каждом отчёте проверки', correspondence: 'Когда вставлено сообщение другого человека или составляется ответ', reply: 'Представь черновик на проверку; перед выдачей проверь длину.', coding: 'При изменении вымышленного кода', github: 'При изменении задач и запросов на слияние', incoming: 'Мара пишет: Можешь завтра принести чертёж?', draft: 'Да, завтра принесу чертёж.', question: 'Почему небо голубое?', calculation: 'Сколько будет 17 + 25?', ok: 'хорошо', code: 'Вывод программы: 42' },
  es: { always: 'Menciona el planeta inventado Lumo en los informes de prueba.', when: 'En cada informe de prueba', correspondence: 'Cuando se pega un mensaje de otra persona o se prepara una respuesta', reply: 'Presenta un borrador para revisión; comprueba su longitud antes de entregarlo.', coding: 'Al modificar código inventado', github: 'Al modificar incidencias y solicitudes de cambios', incoming: 'Mara escribe: ¿Puedes traer el dibujo mañana?', draft: 'Sí, mañana traeré el dibujo.', question: '¿Por qué el cielo es azul?', calculation: '¿Cuánto es 17 + 25?', ok: 'vale', code: 'Salida del programa: 42' },
} as const;
export type Language = keyof typeof languages;
export const validator = { tool: 'validate_artifact', channel: 'discord-dm', limit: 2000, unit: 'utf16' } as const;

export function inventedRules() {
  return Object.entries(languages).flatMap(([lang, t]) => Array.from({length: 25}, (_, i) => {
    const kind = i === 0 ? 'always' : i === 1 ? 'floor' : i === 2 ? 'correspondence' : i === 3 ? 'github' : i === 4 ? 'coding' : `extra-${i}`;
    const fm = { id: `p5-${lang}-${kind}`, title: `${t.when} ${kind}`, summary: t.when,
      type: 'workflow', scope: 'all-projects', tags: ['invented-phase5'], topic_path: ['invented-phase5'],
      recall_when: [`synthetic-anchor-${lang}-${i}`], write_origin: 'user-directed',
      ...(i !== 1 ? {rulebook: i === 0 ? 'always' : 'on-demand', applies_when: i === 2 ? t.correspondence : i === 3 ? t.github : t.coding} : {}),
      ...(i === 2 ? {rule_categories: ['correspondence'], validator} : i === 3 ? {rule_categories: ['github-issues-prs']} : {}),
    };
    return {fm, body: i <= 1 ? `${t.always} COMPLETE_${lang}_${kind}` : `${t.reply} BODY_${lang}_${kind}`};
  }));
}
