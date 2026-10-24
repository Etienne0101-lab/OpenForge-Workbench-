package com.openforge.workbench.data

import android.content.Context
import android.database.sqlite.SQLiteDatabase

/**
 * SQLite workbench, native edition: Android ships SQLite, so the web
 * workbench's in-tab SQL pane becomes a real on-device database
 * (workbench.db in the app's private files). SELECT/PRAGMA results are
 * returned as rows; other statements run via execSQL.
 */
class SqlWorkbench(context: Context) {
    private val db: SQLiteDatabase =
        context.openOrCreateDatabase("workbench.db", Context.MODE_PRIVATE, null)

    fun run(sql: String): String {
        val trimmed = sql.trim()
        if (trimmed.isEmpty()) return "Enter a SQL statement first."
        return try {
            val head = trimmed.substringBefore(" ").uppercase()
            if (head == "SELECT" || head == "PRAGMA" || head == "WITH" || head == "EXPLAIN") {
                val cursor = db.rawQuery(trimmed, null)
                val out = StringBuilder()
                cursor.use {
                    val cols = it.columnNames
                    out.append(cols.joinToString(" | ")).append("\n")
                    var rows = 0
                    while (it.moveToNext()) {
                        val row = (0 until it.columnCount).joinToString(" | ") { i -> it.getString(i) ?: "NULL" }
                        out.append(row).append("\n")
                        rows++
                    }
                    out.append("($rows rows)")
                }
                out.toString()
            } else {
                db.execSQL(trimmed)
                "Statement ran OK."
            }
        } catch (e: Exception) {
            "SQL error: ${e.message}"
        }
    }
}
