package com.example.youtube

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.*
import android.widget.FrameLayout
import androidx.annotation.RequiresApi

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var container: FrameLayout
    
    companion object {
        private const val TAG = "YouTubeActivity"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        // Initialize container
        container = FrameLayout(this)
        
        // Enable hardware acceleration for better video performance
        window.setFlags(
            android.view.WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            android.view.WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED
        )
        
        // Request audio focus
        val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        audioManager.requestAudioFocus(
            null,
            AudioManager.STREAM_MUSIC,
            AudioManager.AUDIOFOCUS_GAIN
        )
        
        // Create WebView with extended capabilities
        webView = object : WebView(this) {
            override fun onWindowVisibilityChanged(visibility: Int) {
                super.onWindowVisibilityChanged(View.VISIBLE)
                // Keep the WebView visible to maintain playback
                if (visibility != View.VISIBLE) {
                    this.visibility = View.INVISIBLE
                }
            }
            
            override fun onPause() {
                // Override to prevent standard WebView pause
                // Don't call super.onPause() to keep audio playing
            }
            
            override fun onResume() {
                super.onResume()
                // Keep timers running
                resumeTimers()
            }
        }.apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = true
                allowContentAccess = true
                allowUniversalAccessFromFileURLs = true
                allowFileAccessFromFileURLs = true
                mediaPlaybackRequiresUserGesture = false
                setSupportZoom(true)
                builtInZoomControls = true
                displayZoomControls = false
                
                // Enable more features for YouTube
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                }
                
                // Enable caching
                cacheMode = WebSettings.LOAD_DEFAULT
            }
            
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url.toString()
                    return if (url.startsWith("https://m.youtube.com") || 
                               url.startsWith("https://www.youtube.com")) {
                        false // Load in WebView
                    } else {
                        // Handle external links if needed
                        false
                    }
                }
                
                override fun onPageFinished(view: WebView, url: String) {
                    super.onPageFinished(view, url)
                    
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                        // Inject JavaScript from assets (adblock + background playback)
                        try {
                            val inputStream = assets.open("adblock.js")
                            val jsCode = inputStream.bufferedReader().use { it.readText() }
                            evaluateJavascript(jsCode, null)
                        } catch (e: Exception) {
                            Log.e(TAG, "Failed to load adblock.js", e)
                        }
                    }
                    Log.d(TAG, "Page loaded: $url")
                }
            }
            
            // Load YouTube mobile site with desktop user agent for better features
            val userAgent = settings.userAgentString
            settings.userAgentString = userAgent?.replace("Mobile", "Desktop") ?: userAgent
            
            // YouTube URL with specific parameters for mobile site
            loadUrl("https://m.youtube.com")
        }
        
        // Add WebView to container
        container.addView(webView)
        setContentView(container)
    }

    override fun onPause() {
        super.onPause()
        // Don't pause the WebView - keep audio playing
        webView.resumeTimers() // Ensure timers are running
        
        // Start foreground service for background audio
        val intent = android.content.Intent(this, AudioPlaybackService::class.java)
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
        
        Log.d(TAG, "onPause - Keeping audio playing")
    }

    override fun onResume() {
        super.onResume()
        // Resume timers and ensure WebView is active
        webView.onResume()
        webView.resumeTimers()
        
        // Stop foreground service when returning to app
        stopService(android.content.Intent(this, AudioPlaybackService::class.java))
        
        Log.d(TAG, "onResume - WebView resumed")
    }

    override fun onStop() {
        super.onStop()
        // Don't pause WebView to keep audio playing
        // Only stop if user explicitly wants to stop
    }

    override fun onDestroy() {
        super.onDestroy()
        // Stop service if it's running
        stopService(android.content.Intent(this, AudioPlaybackService::class.java))
        
        // Clean up WebView
        webView.apply {
            loadUrl("about:blank")
            clearHistory()
            clearCache(true)
            removeAllViews()
            destroy()
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        // Handle volume buttons to control media
        if (keyCode == KeyEvent.KEYCODE_VOLUME_UP || 
            keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) {
            val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            audioManager.adjustStreamVolume(
                AudioManager.STREAM_MUSIC,
                if (keyCode == KeyEvent.KEYCODE_VOLUME_UP) 
                    AudioManager.ADJUST_RAISE 
                else 
                    AudioManager.ADJUST_LOWER,
                AudioManager.FLAG_SHOW_UI
            )
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            webView.resumeTimers()
        }
    }
}