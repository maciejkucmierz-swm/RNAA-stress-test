package com.rnaa.interrupter;
import android.app.*;
import android.content.Intent;
import android.media.*;
import android.os.*;
public class InterrupterService extends Service {
  private final Handler handler = new Handler(Looper.getMainLooper());
  private AudioManager manager; private AudioFocusRequest request; private AudioTrack track;
  private int left, seconds, gain;
  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel("focus", "Audio focus test", NotificationManager.IMPORTANCE_LOW));
    startForeground(1, new Notification.Builder(this, "focus").setContentTitle("Audio focus test running").setSmallIcon(android.R.drawable.ic_media_play).build());
    release(); handler.removeCallbacksAndMessages(null);
    String mode = intent == null ? "transient" : intent.getStringExtra("mode");
    gain = "permanent".equals(mode) ? AudioManager.AUDIOFOCUS_GAIN : "duck".equals(mode) ? AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK : AudioManager.AUDIOFOCUS_GAIN_TRANSIENT;
    seconds = Math.max(1, Math.min(10, intent == null ? 3 : intent.getIntExtra("seconds", 3)));
    left = Math.max(1, Math.min(20, intent == null ? 5 : intent.getIntExtra("rounds", 5)));
    manager = getSystemService(AudioManager.class); cycle(); return START_NOT_STICKY;
  }
  private void cycle() {
    AudioAttributes attributes = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build();
    request = new AudioFocusRequest.Builder(gain).setAudioAttributes(attributes).setOnAudioFocusChangeListener(change -> android.util.Log.i("AudioInterrupter", "focus=" + change)).build();
    int result = manager.requestAudioFocus(request); android.util.Log.i("AudioInterrupter", "request=" + result + " gain=" + gain);
    if (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
      short[] tone = new short[48000]; for (int i = 0; i < tone.length; i++) tone[i] = (short)(Math.sin(2 * Math.PI * 660 * i / 48000) * 1500);
      track = new AudioTrack.Builder().setAudioAttributes(attributes).setAudioFormat(new AudioFormat.Builder().setSampleRate(48000).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build()).setBufferSizeInBytes(tone.length * 2).setTransferMode(AudioTrack.MODE_STATIC).build();
      track.write(tone, 0, tone.length); track.setLoopPoints(0, tone.length, -1); track.play();
    }
    handler.postDelayed(() -> { release(); if (--left > 0) handler.postDelayed(this::cycle, 1000); else stopSelf(); }, seconds * 1000L);
  }
  private void release() {
    if (track != null) { track.stop(); track.release(); track = null; }
    if (manager != null && request != null) manager.abandonAudioFocusRequest(request); request = null;
  }
  @Override public void onDestroy() { handler.removeCallbacksAndMessages(null); release(); stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy(); }
  @Override public IBinder onBind(Intent intent) { return null; }
}
