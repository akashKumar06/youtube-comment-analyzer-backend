import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { LanguageServiceClient } from "@google-cloud/language";

const PORT = process.env.PORT;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

const app = express();

const corsOptions = {
  origin: "*",
  methods: "GET,OPTIONS",
  allowedHeaders: "Content-Type,Authorization",
  credentials: true,
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.use(express.json());

// --- Google Cloud Natural Language API Client Initialization ---
let languageClient;
try {
  if (process.env.GOOGLE_CLOUD_NATURAL_LANGUAGE_KEY_JSON) {
    // For Render deployment, where the key JSON is stored in an environment variable
    languageClient = new LanguageServiceClient({
      credentials: JSON.parse(
        process.env.GOOGLE_CLOUD_NATURAL_LANGUAGE_KEY_JSON
      ),
    });
    console.log(
      "Natural Language Client initialized using GOOGLE_CLOUD_NATURAL_LANGUAGE_KEY_JSON."
    );
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // For deployments where a JSON key file is mounted and path is set via GOOGLE_APPLICATION_CREDENTIALS
    languageClient = new LanguageServiceClient();
    console.log(
      "Natural Language Client initialized using GOOGLE_APPLICATION_CREDENTIALS."
    );
  } else {
    // For local development, if you rely on `gcloud auth application-default login` or no explicit env var
    languageClient = new LanguageServiceClient();
    console.warn(
      "Natural Language Client initialized without explicit JSON key or GOOGLE_APPLICATION_CREDENTIALS. Ensure credentials are set via gcloud CLI or environment variable."
    );
  }
} catch (error) {
  console.error("Failed to initialize Natural Language Client:", error);
  // You might want to exit or handle this more gracefully depending on your app's needs
  // process.exit(1);
}

app.get("/", (req, res) => {
  return res.send("Youtube comment analyzer backend is running.");
});

app.get("/comments", async (req, res) => {
  try {
    const videoId = req.query.videoId;
    let pageToken = req.query.pageToken || null;

    if (!videoId)
      return res.status(400).json({ message: "Missing videoId parameter" });

    if (!YOUTUBE_API_KEY) {
      console.error("YOUTUBE_API_KEY environment variable is not set!");
      return res
        .status(500)
        .json({ message: "Server configuration error: API Key missing." });
    }

    const maxResults = 100;
    let allComments = [];
    let fetchedCommentCount = 0;
    const maxCommentsToFetch = 100; // Limit to avoid excessive API usage

    do {
      let apiUrl = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${videoId}&maxResults=${maxResults}&key=${YOUTUBE_API_KEY}`;
      if (pageToken) {
        apiUrl += `&pageToken=${pageToken}`;
      }

      const youtubeResponse = await fetch(apiUrl);
      const youtubeData = await youtubeResponse.json();

      if (!youtubeResponse.ok) {
        console.error("YouTube API responded with error:", youtubeData);
        return res.status(youtubeResponse.status).json({
          message: youtubeData.error
            ? youtubeData.error.message
            : "Error from YouTube API",
          details: youtubeData.error ? youtubeData.error.errors : null,
        });
      }

      if (youtubeData.items && youtubeData.items.length > 0) {
        const commentsToAdd = youtubeData.items
          .map((item) => {
            return item.snippet.topLevelComment.snippet.textOriginal;
          })
          .filter((text) => text); // Filter out any empty comments

        allComments = allComments.concat(commentsToAdd);
        fetchedCommentCount += commentsToAdd.length;
      }

      pageToken = youtubeData.nextPageToken;

      // Small delay to be kind to YouTube API and manage rate limits
      if (pageToken && fetchedCommentCount < maxCommentsToFetch) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } while (pageToken && fetchedCommentCount < maxCommentsToFetch);

    if (allComments.length === 0) {
      return res
        .status(200)
        .json({ message: "No comments found or fetched.", comments: [] });
    }

    // --- Perform Sentiment and Entity Analysis CONCURRENTLY ---
    const analysisPromises = allComments.map(async (commentText) => {
      try {
        const document = {
          content: commentText,
          type: "PLAIN_TEXT",
        };

        // Concurrent promises for sentiment AND entity analysis for each comment
        const [sentimentResult, entityResult] = await Promise.all([
          languageClient.analyzeSentiment({ document: document }),
          languageClient.analyzeEntities({ document: document }), // New: Entity Analysis
        ]);

        const sentiment = sentimentResult.documentSentiment;
        const entities = entityResult.entities; // Get entities from the result

        return {
          text: commentText,
          sentiment: {
            score: sentiment.score,
            magnitude: sentiment.magnitude,
          },
          // NEW: Include entities for each comment
          entities: entities.map((entity) => ({
            name: entity.name,
            type: entity.type,
            salience: entity.salience, // Importance of the entity in the text (0.0 to 1.0)
            // You can add more entity properties if needed, like sentiment for entity.
            // Note: Entity sentiment is more complex and might not be available for all types or directly applicable.
          })),
        };
      } catch (analysisError) {
        console.warn(
          `Could not analyze comment: "${commentText}". Error: ${analysisError.message}`
        );
        return {
          text: commentText,
          sentiment: {
            score: null,
            magnitude: null,
            error: analysisError.message,
          },
          entities: [], // Return empty array on error
        };
      }
    });

    const commentsWithAnalysis = await Promise.all(analysisPromises);

    // --- NEW: Process Entities to Find Common Themes ---
    const themeCounts = {};
    const themeSentimentScores = {}; // To store sentiment for each theme
    const minSalienceForTheme = 0.05; // Entities below this salience might be less relevant
    const minThemeOccurrences = 2; // Only consider themes appearing at least X times

    commentsWithAnalysis.forEach((comment) => {
      if (
        comment.entities &&
        comment.sentiment &&
        comment.sentiment.score !== null
      ) {
        comment.entities.forEach((entity) => {
          // Filter for common types that are likely themes (PERSON, LOCATION, ORGANIZATION might be less relevant for general themes)
          // Common types for themes: WORK_OF_ART, CONSUMER_GOOD, OTHER, EVENT, PRODUCT
          if (
            [
              "WORK_OF_ART",
              "CONSUMER_GOOD",
              "OTHER",
              "EVENT",
              "PRODUCT",
              "UNKNOWN",
            ].includes(entity.type) &&
            entity.salience > minSalienceForTheme
          ) {
            const themeName = entity.name.toLowerCase(); // Standardize to lowercase

            themeCounts[themeName] = (themeCounts[themeName] || 0) + 1;
            themeSentimentScores[themeName] = themeSentimentScores[
              themeName
            ] || { sum: 0, count: 0 };
            themeSentimentScores[themeName].sum += comment.sentiment.score;
            themeSentimentScores[themeName].count++;
          }
        });
      }
    });

    const commonThemes = [];
    for (const theme in themeCounts) {
      if (themeCounts[theme] >= minThemeOccurrences) {
        const avgSentiment =
          themeSentimentScores[theme].count > 0
            ? themeSentimentScores[theme].sum /
              themeSentimentScores[theme].count
            : 0;
        let sentimentCategory = "neutral";
        if (avgSentiment > 0.2) sentimentCategory = "positive";
        else if (avgSentiment < -0.2) sentimentCategory = "negative";

        commonThemes.push({
          name: theme,
          occurrences: themeCounts[theme],
          averageSentiment: avgSentiment.toFixed(2),
          sentimentCategory: sentimentCategory,
        });
      }
    }

    // Sort themes by occurrences (most common first)
    commonThemes.sort((a, b) => b.occurrences - a.occurrences);

    res.status(200).json({
      message: `Successfully fetched and analyzed ${commentsWithAnalysis.length} comments.`,
      comments: commentsWithAnalysis, // Still send individual comments if needed
      videoCategory: videoCategory,
      themes: commonThemes.slice(0, 5), // Return top 5 themes
    });
  } catch (error) {
    console.error("Error in backend comment fetch:", error);
    res
      .status(500)
      .json({ message: "Internal Server Error", error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is listening on port: ${PORT}`);
});
