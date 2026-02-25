Return valid JSON only.
Do not include markdown fences.
Do not include commentary, headings, or any text before/after JSON.
The first character of your response must be '{' and the last must be '}'.
Output must match: {"diagnostics":[{"rule_id":"<id>","severity":"error|warn|info","message":"<text>","file":"<path>","line":1}]}
