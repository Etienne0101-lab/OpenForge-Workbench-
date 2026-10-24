package com.openforge.workbench

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.openforge.workbench.ui.WorkbenchApp
import com.openforge.workbench.ui.WorkbenchTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            WorkbenchTheme {
                WorkbenchApp()
            }
        }
    }
}
