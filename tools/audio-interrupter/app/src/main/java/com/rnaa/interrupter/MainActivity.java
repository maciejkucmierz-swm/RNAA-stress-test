package com.rnaa.interrupter;
import android.app.Activity;
import android.os.Bundle;
import android.content.Intent;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
public class MainActivity extends Activity {
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); layout.setPadding(24, 48, 24, 24);
    TextView title = new TextView(this); title.setText("Real Android audio-focus interruptions. Start the lab’s scenario first. Each button requests focus for 3 seconds, releases it, and repeats 5 times."); layout.addView(title);
    for (String mode : new String[]{"transient", "permanent", "duck"}) {
      Button button = new Button(this); button.setText(mode); button.setOnClickListener(v -> start(mode, 3, 5)); layout.addView(button);
    }
    Button stop = new Button(this); stop.setText("Stop helper"); stop.setOnClickListener(v -> stopService(new Intent(this, InterrupterService.class))); layout.addView(stop);
    setContentView(layout);
    if (getIntent().hasExtra("mode")) start(getIntent().getStringExtra("mode"), getIntent().getIntExtra("seconds", 3), getIntent().getIntExtra("rounds", 5));
  }
  private void start(String mode, int seconds, int rounds) {
    startForegroundService(new Intent(this, InterrupterService.class).putExtra("mode", mode).putExtra("seconds", seconds).putExtra("rounds", rounds));
  }
}
