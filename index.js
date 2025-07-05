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

    // --- Perform Sentiment Analysis CONCURRENTLY ---
    // Create an array of Promises, one for each sentiment analysis call
    const sentimentPromises = allComments.map(async (commentText) => {
      try {
        const document = {
          content: commentText,
          type: "PLAIN_TEXT",
        };

        // Send the request, but don't await immediately
        const [sentimentResult] = await languageClient.analyzeSentiment({
          document: document,
        });
        const sentiment = sentimentResult.documentSentiment;

        return {
          text: commentText,
          sentiment: {
            score: sentiment.score,
            magnitude: sentiment.magnitude,
          },
        };
      } catch (sentimentError) {
        // Log the error but return an object indicating failure for this comment
        console.warn(
          `Could not analyze sentiment for comment: "${commentText}". Error: ${sentimentError.message}`
        );
        return {
          text: commentText,
          sentiment: {
            score: null,
            magnitude: null,
            error: sentimentError.message,
          },
        };
      }
    });

    // Await all promises to resolve concurrently
    const commentsWithSentiment = await Promise.all(sentimentPromises);

    res.status(200).json({
      message: `Successfully fetched and analyzed ${commentsWithSentiment.length} comments.`,
      comments: commentsWithSentiment,
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
