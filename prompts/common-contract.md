Output schema:
{
  "diagnostics": [
    {
      "rule_id": string,
      "severity": "error" | "warn" | "info",
      "message": string,
      "file": string,
      "line": number,
      "column"?: number,
      "end_line"?: number,
      "end_column"?: number,
      "evidence"?: string,
      "confidence"?: number
    }
  ]
}
Rules:
- If there are no findings, return {"diagnostics":[]}.
- Each diagnostic must reference a changed file from the DIFF.
